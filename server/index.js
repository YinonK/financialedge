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
const telegramWebhookRoutes = require('./routes/telegramWebhook');
const contextRoutes = require('./routes/context');
const gemini = require('./services/gemini');
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
app.use('/api/telegram/webhook', telegramWebhookRoutes);
app.use('/api/context', contextRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    geminiConfigured: gemini.isConfigured(),
    telegramOutboundConfigured: telegram.isConfigured(),
    telegramIngestConfigured: telegramIngest.isConfigured(),
    telegramIngestChannels: telegramIngest.getConfiguredChannels(),
    time: new Date().toISOString(),
  });
});

// Static frontend (vanilla JS, no build step)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`FinancialEdge server listening on http://localhost:${PORT}`);

  if (!gemini.isConfigured()) {
    console.log(
      '[startup] GEMINI_API_KEY is not set. Research/Chat will return a clear "not configured" message until you add one.'
    );
    console.log('[startup] Get a free key at https://aistudio.google.com/apikey and add it to .env as GEMINI_API_KEY.');
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
