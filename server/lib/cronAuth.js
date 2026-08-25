'use strict';

/**
 * Shared secret check for the three cron-triggered endpoints (briefing,
 * watchdog, signal ingest). One key, one header, so Yinon only has to wire
 * up cron-job.org once and reuse the same header value for all three jobs.
 *
 * Accepts CRON_KEY (preferred) or the older BRIEFING_KEY name, and either
 * the X-Cron-Key or legacy X-Briefing-Key header, so nothing breaks if one
 * endpoint was configured before this rename.
 */
function requireCronKey(req, res) {
  const expectedKey = process.env.CRON_KEY || process.env.BRIEFING_KEY;
  const providedKey = req.get('X-Cron-Key') || req.get('X-Briefing-Key');

  if (!expectedKey || expectedKey === 'change-me') {
    res.status(500).json({
      error: 'CRON_KEY is not set (or still the default) in .env — set a real secret before wiring up cron-job.org.',
    });
    return false;
  }
  if (providedKey !== expectedKey) {
    res.status(401).json({ error: 'invalid or missing X-Cron-Key header' });
    return false;
  }
  return true;
}

/**
 * A scheduled job that 500s used to fail silently — cron-job.org logs it, but
 * nobody reads those logs. One Telegram line the moment it breaks means the
 * system's failures are as visible as its successes. Never throws.
 */
async function reportCronFailure(jobName, err) {
  try {
    const { sendMessage } = require('../services/telegram');
    await sendMessage(
      `⚠️ Scheduled job failed: ${jobName}\n\n${String(err && err.message).slice(0, 300)}\n\nThe job will retry on its normal schedule. If this keeps appearing, check the Render logs.`
    );
  } catch (e) {
    console.error(`[cron] could not report ${jobName} failure:`, e.message);
  }
}

module.exports = { requireCronKey, reportCronFailure };
