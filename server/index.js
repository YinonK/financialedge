'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');

const marketRoutes = require('./routes/market');
const portfolioRoutes = require('./routes/portfolio');
const researchRoutes = require('./routes/research');
const signalsRoutes = require('./routes/signals');
const brainRoutes = require('./routes/brain');
const briefingRoutes = require('./routes/briefing');
const watchdogRoutes = require('./routes/watchdog');
const journalRoutes = require('./routes/journal');
const positionsRoutes = require('./routes/positions');
const settingsRoutes = require('./routes/settings');
const analysesRoutes = require('./routes/analyses');
const opportunitiesRoutes = require('./routes/opportunities');
const reviewRoutes = require('./routes/review');
const telegramWebhookRoutes = require('./routes/telegramWebhook');
const contextRoutes = require('./routes/context');
const { initStore, flushStore, storageStatus } = require('./lib/store');
const council = require('./services/council');
const telegram = require('./services/telegram');
const telegramIngest = require('./services/telegramIngest');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// API routes
app.use('/api/market', marketRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/research', researchRoutes);
app.use('/api/signals', signalsRoutes);
app.use('/api/brain', brainRoutes);
app.use('/api/briefing', briefingRoutes);
app.use('/api/watchdog', watchdogRoutes);
app.use('/api/journal', journalRoutes);
app.use('/api/positions', positionsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/analyses', analysesRoutes);
app.use('/api/opportunities', opportunitiesRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api/telegram/webhook', telegramWebhookRoutes);
app.use('/api/context', contextRoutes);

/**
 * Keep-alive ping. Deliberately the cheapest possible route: no auth, no
 * disk, no network, no JSON building — just a 200 with two bytes.
 *
 * Why it exists: Render's free tier sleeps after ~15 minutes idle, and a cold
 * start takes 30-60s. The scheduled jobs (ingest every 15 min, watchdog every
 * 30) were landing right on that boundary and hitting a sleeping instance,
 * which blows past cron-job.org's 30s timeout and shows up as a 503. A ping
 * every ~10 minutes keeps the instance warm so the real jobs always hit a
 * live server.
 *
 * Kept separate from /api/health on purpose — health is a diagnostics
 * endpoint whose payload grows over time and reveals configuration state.
 * This one has a stable, boring contract and discloses nothing.
 */
app.get('/api/ping', (req, res) => {
  res.type('text/plain').status(200).send('ok');
});

app.get('/api/health', (req, res) => {
  const providers = council.configuredProviders();
  const chair = council.chairProvider();
  res.json({
    ok: true,
    geminiConfigured: providers.some((p) => p.id === 'gemini'), // kept for backward compat
    aiProviders: providers.map((p) => p.label),
    aiChair: chair ? chair.label : null,
    councilNegotiation: providers.length >= 2,
    providerHealth: council.getProviderHealth(),
    telegramOutboundConfigured: telegram.isConfigured(),
    telegramIngestConfigured: telegramIngest.isConfigured(),
    telegramIngestChannels: telegramIngest.getConfiguredChannels(),
    storage: storageStatus(),
    time: new Date().toISOString(),
  });
});

// Static frontend (vanilla JS, no build step)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Load persisted state BEFORE accepting traffic, so the first request never
// sees an empty context that later gets overwritten.
initStore()
  .catch((err) => console.error('[startup] storage init failed, continuing on local file:', err.message))
  .then(() => {
app.listen(PORT, () => {
  console.log(`FinancialEdge server listening on http://localhost:${PORT}`);
  const st = storageStatus();
  console.log(
    `[startup] Storage: ${st.backend}${
      st.backend === 'file'
        ? ' — data will NOT survive a Render redeploy. Set SUPABASE_URL + SUPABASE_SERVICE_KEY to fix.'
        : ' (durable)'
    }`
  );

  const providers = council.configuredProviders();
  if (!providers.length) {
    console.log(
      '[startup] No AI provider configured. Research/Chat will return a clear "not configured" message until you add one.'
    );
    console.log(
      '[startup] Add at least one to .env: GEMINI_API_KEY (free, https://aistudio.google.com/apikey), ANTHROPIC_API_KEY, or OPENAI_API_KEY.'
    );
  } else {
    console.log(
      `[startup] AI Council: ${providers.map((p) => p.label).join(', ')} — ${
        providers.length >= 2 ? 'negotiation ON' : 'single voice (add a second provider key to enable negotiation)'
      }`
    );
  }

  if (!telegram.isConfigured()) {
    console.log(
      '[startup] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set. Briefing/watchdog alerts will log to console instead of sending.'
    );
  } else {
    telegram.registerWebhook();
  }

  if (!telegramIngest.isConfigured()) {
    console.log(
      '[startup] Telegram channel ingestion not configured (TELEGRAM_API_ID/API_HASH/SESSION/CHANNELS) — see README for setup via `npm run telegram:login`.'
    );
  }
});

// Flush queued writes before the process dies, so a redeploy doesn't drop
// the last few seconds of work.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`[shutdown] ${sig} received — flushing pending writes...`);
    try {
      await flushStore();
      console.log('[shutdown] writes flushed.');
    } catch (err) {
      console.error('[shutdown] flush failed:', err.message);
    }
    process.exit(0);
  });
}
  });
