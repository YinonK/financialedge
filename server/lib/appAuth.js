'use strict';

/**
 * App-wide API authentication.
 *
 * Before this existed, only the cron endpoints checked a key. Everything else
 * — the full context dump, the paid research endpoint, brain chat, position
 * deletes — was open to anyone who found the Render URL. For a tool holding a
 * real portfolio and real API keys, that was the single biggest gap.
 *
 * Model: one shared secret (APP_KEY env var). The browser sends it as an
 * X-App-Key header; the Settings-free way to enter it is a one-time prompt
 * stored in localStorage (see public/js/api.js). Cron requests keep using
 * X-Cron-Key exactly as before — either key is accepted, so nothing about the
 * cron-job.org setup changes.
 *
 * Exemptions:
 *   /api/ping              — must stay free: it's the keep-alive target
 *   /api/telegram/webhook  — Telegram can't send custom headers; it has its
 *                            own secret-token + chat-id checks
 *
 * If APP_KEY is not set, everything is allowed and a loud warning is logged
 * once — so an existing deployment keeps working until the var is added,
 * instead of bricking itself on deploy.
 */

let warnedOnce = false;

const EXEMPT_PATHS = new Set(['/api/ping', '/api/telegram/webhook']);

function appAuth(req, res, next) {
  if (!req.path.startsWith('/api/')) return next(); // static files are public, they contain no data
  if (EXEMPT_PATHS.has(req.path)) return next();

  const appKey = process.env.APP_KEY;
  if (!appKey) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        '[auth] APP_KEY is not set — the API is OPEN to anyone with the URL. Set APP_KEY in Render → Environment to lock it down.'
      );
    }
    return next();
  }

  const provided = req.get('X-App-Key');
  if (provided === appKey) return next();

  // Cron jobs authenticate with their own key; accept it everywhere so the
  // scheduled endpoints don't need two headers.
  const cronKey = process.env.CRON_KEY || process.env.BRIEFING_KEY;
  const providedCron = req.get('X-Cron-Key') || req.get('X-Briefing-Key');
  if (cronKey && cronKey !== 'change-me' && providedCron === cronKey) return next();

  return res.status(401).json({ error: 'unauthorized — missing or wrong X-App-Key', code: 'APP_KEY_REQUIRED' });
}

module.exports = { appAuth };
