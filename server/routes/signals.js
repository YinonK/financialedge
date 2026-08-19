'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, writeContext } = require('../lib/store');
const { detectTickers } = require('../lib/tickerDetect');
const { ingestNewSignals } = require('../services/telegramIngest');
const { sendMessage } = require('../services/telegram');
const { requireCronKey } = require('../lib/cronAuth');
const council = require('../services/council');
const { SYSTEM_PERSONA } = require('../services/brain');

const router = express.Router();

const CONVERGENCE_WINDOW_DAYS = 14;
const CONVERGENCE_MIN_COUNT = 2;
const STRONG_CONVERGENCE_MIN_COUNT = 3;

function computeConvergence(items) {
  const cutoff = Date.now() - CONVERGENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recent = items.filter((s) => new Date(s.pastedAt).getTime() >= cutoff);

  const byTicker = new Map();
  for (const item of recent) {
    for (const ticker of item.tickers) {
      if (!byTicker.has(ticker)) byTicker.set(ticker, []);
      byTicker.get(ticker).push({ id: item.id, pastedAt: item.pastedAt, source: item.source });
    }
  }

  return [...byTicker.entries()]
    .map(([ticker, mentions]) => ({
      ticker,
      count: mentions.length,
      convergence: mentions.length >= CONVERGENCE_MIN_COUNT,
      strongConvergence: mentions.length >= STRONG_CONVERGENCE_MIN_COUNT,
      mentions,
    }))
    .filter((r) => r.count >= CONVERGENCE_MIN_COUNT)
    .sort((a, b) => b.count - a.count);
}

router.get('/', (req, res) => {
  const context = readContext();
  const items = [...context.signals.items].sort((a, b) => new Date(b.pastedAt) - new Date(a.pastedAt));
  res.json(items);
});

router.post('/', (req, res) => {
  const body = req.body || {};
  if (!body.rawText || !body.rawText.trim()) {
    return res.status(400).json({ error: 'rawText is required' });
  }
  const context = readContext();
  const item = {
    id: crypto.randomUUID(),
    pastedAt: new Date().toISOString(),
    rawText: body.rawText.trim(),
    tickers: detectTickers(body.rawText),
    source: body.source || 'manual paste',
  };
  context.signals.items.push(item);
  writeContext(context);
  res.status(201).json(item);
});

router.delete('/:id', (req, res) => {
  const context = readContext();
  const before = context.signals.items.length;
  context.signals.items = context.signals.items.filter((s) => s.id !== req.params.id);
  if (context.signals.items.length === before) {
    return res.status(404).json({ error: 'signal not found' });
  }
  writeContext(context);
  res.status(204).end();
});

router.get('/convergence/report', (req, res) => {
  const context = readContext();
  const report = computeConvergence(context.signals.items);
  res.json({
    windowDays: CONVERGENCE_WINDOW_DAYS,
    generatedAt: new Date().toISOString(),
    convergences: report,
  });
});

// Triggered by cron-job.org — pulls new posts from Yinon's configured Telegram
// alpha channels (via a short-lived MTProto session; see services/telegramIngest.js)
// and feeds them into the same signal store + convergence detector as manual
// paste. Gracefully reports "not configured" if the Telegram user session
// hasn't been set up yet — never blocks the rest of the app.
router.post('/ingest', async (req, res) => {
  if (!requireCronKey(req, res)) return;

  try {
    const context = readContext();
    const result = await ingestNewSignals(context.telegramIngest.lastMessageId);

    if (!result.configured) {
      return res.json({ ingested: 0, configured: false, reason: result.reason });
    }

    if (result.newItems.length) {
      context.signals.items.push(...result.newItems);
      context.telegramIngest.lastMessageId = result.updatedCheckpoints;
      writeContext(context);

      // If any freshly-ingested ticker just crossed the convergence
      // threshold, that's worth a proactive nudge rather than waiting for
      // Yinon to open the Signals screen.
      const freshTickers = new Set(result.newItems.flatMap((i) => i.tickers));
      const convergences = computeConvergence(context.signals.items).filter((c) => freshTickers.has(c.ticker));
      if (convergences.length) {
        // A new convergence is a significant signal — get the Council's
        // quick multi-model read before alerting. Never blocks the alert.
        let councilRead = null;
        try {
          const relatedSignals = context.signals.items
            .filter((s) => s.tickers.some((t) => convergences.some((c) => c.ticker === t)))
            .slice(-10);
          councilRead = await council.quickTake(
            SYSTEM_PERSONA,
            `New signal convergence just detected in Yinon's followed channels:\n${convergences
              .map((c) => `- ${c.ticker}: ${c.count} mentions in ${CONVERGENCE_WINDOW_DAYS}d${c.strongConvergence ? ' (strong)' : ''}`)
              .join('\n')}\n\nThe underlying signals (raw pastes/channel posts):\n${JSON.stringify(relatedSignals, null, 2)}`
          );
        } catch (err) {
          console.error('[signals:ingest] council quickTake failed:', err.message);
        }

        const text = `FinancialEdge — new convergence detected:\n\n${convergences
          .map((c) => `• ${c.ticker}: ${c.count} mentions in ${CONVERGENCE_WINDOW_DAYS}d${c.strongConvergence ? ' (strong)' : ''}`)
          .join('\n')}${councilRead ? `\n\nCouncil read: ${councilRead}` : ''}`;
        await sendMessage(text).catch((err) => console.error('[signals:ingest] alert send failed:', err.message));
      }
    }

    res.json({
      ingested: result.newItems.length,
      configured: true,
      perChannel: result.perChannel || {},
      errors: result.errors || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
