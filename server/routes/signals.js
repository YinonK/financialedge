'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, writeContext } = require('../lib/store');
const { detectTickers } = require('../lib/tickerDetect');
const { extractFromMessages } = require('../services/entityExtract');
const { ingestNewSignals } = require('../services/telegramIngest');
const { sendMessage } = require('../services/telegram');
const { requireCronKey } = require('../lib/cronAuth');
const council = require('../services/council');
const { recordAnalysis } = require('../services/analysisStore');
const { buildProvenanceBlock } = require('../services/provenance');

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

router.post('/', async (req, res) => {
  const body = req.body || {};
  if (!body.rawText || !body.rawText.trim()) {
    return res.status(400).json({ error: 'rawText is required' });
  }
  const context = readContext();

  // Full extraction, so a pasted Hebrew article is understood the same way an
  // ingested Hebrew channel post is.
  let enrichment = { tickers: detectTickers(body.rawText), entities: [], extractionMethod: 'regex' };
  try {
    const out = await extractFromMessages(
      [{ rawText: body.rawText.trim(), source: body.source || 'manual paste' }],
      { knownMappings: context.entityCache.mappings }
    );
    if (out.enrichments[0]) enrichment = out.enrichments[0];
    Object.assign(context.entityCache.mappings, out.newMappings);
  } catch (err) {
    console.error('[signals] extraction failed, falling back to regex:', err.message);
  }

  const item = {
    id: crypto.randomUUID(),
    pastedAt: new Date().toISOString(),
    rawText: body.rawText.trim(),
    tickers: enrichment.tickers || [],
    source: body.source || 'manual paste',
    parsed: enrichment,
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
      // Extraction runs BEFORE storage, so Hebrew posts arrive with real
      // tickers attached instead of an empty array that silently drops them
      // out of every downstream feature.
      let extraction = { enrichments: [], llmCalls: 0, newMappings: {} };
      try {
        extraction = await extractFromMessages(result.newItems, {
          knownMappings: context.entityCache.mappings,
        });
        Object.assign(context.entityCache.mappings, extraction.newMappings);
      } catch (err) {
        console.error('[signals:ingest] extraction failed, keeping regex tickers:', err.message);
      }

      const unmappedNames = new Set(context.entityCache.unmapped || []);
      result.newItems.forEach((item, i) => {
        const e = extraction.enrichments[i];
        if (!e) return;
        if (e.tickers && e.tickers.length) item.tickers = e.tickers;
        item.parsed = e;
        for (const name of e.unmappedCompanies || []) unmappedNames.add(name);
      });
      context.entityCache.unmapped = [...unmappedNames].slice(-200);

      context.signals.items.push(...result.newItems);
      context.telegramIngest.lastMessageId = result.updatedCheckpoints;
      writeContext(context);

      // If any freshly-ingested ticker just crossed the convergence
      // threshold, that's worth a proactive nudge rather than waiting for
      // Yinon to open the Signals screen.
      const freshTickers = new Set(result.newItems.flatMap((i) => i.tickers));
      const convergences = computeConvergence(context.signals.items).filter((c) => freshTickers.has(c.ticker));
      if (convergences.length) {
        // A new convergence is exactly the moment worth arguing about, so the
        // full Council brainstorms it (independent takes → rebuttals →
        // consensus) rather than giving a one-shot opinion. Never blocks the
        // alert: if the Council is down, the alert still goes out and says so.
        const relatedSignals = context.signals.items
          .filter((s) => s.tickers.some((t) => convergences.some((c) => c.ticker === t)))
          .slice(-12);

        let councilResult = null;
        let councilError = null;
        try {
          const situation = `SIGNAL CONVERGENCE — the same name keeps coming up across Yinon's Telegram alpha channels.

Convergences detected:
${convergences
  .map((c) => `- ${c.ticker}: ${c.count} mentions in ${CONVERGENCE_WINDOW_DAYS} days${c.strongConvergence ? ' (STRONG)' : ''}`)
  .join('\n')}

${buildProvenanceBlock({
  signals: relatedSignals,
  dataFeeds: {},
  extraNotes: [
    'These posts are mostly HEBREW. Company names may appear only in Hebrew. Where a post has a "parsed" field, that is our own extraction of the companies and claims — treat the extraction as our reading, and the rawText as the source of truth.',
  ],
})}

=== THE UNDERLYING POSTS ===
${JSON.stringify(relatedSignals, null, 2)}

Is this convergence worth Yinon's attention, or is it noise? Repetition is not evidence — several posts from one channel is one opinion repeated. Say plainly if that is what this is.`;

          councilResult = await council.convene(situation, {
            settings: context.settings,
            costLabel: 'signal convergence',
          });
        } catch (err) {
          console.error('[signals:ingest] council failed:', err.message);
          councilError = err.message;
        }

        let analysisId = null;
        if (councilResult && councilResult.seats && councilResult.seats.length) {
          const rec = recordAnalysis({
            tickers: convergences.map((c) => c.ticker),
            ticker: convergences[0] ? convergences[0].ticker : null,
            kind: 'convergence',
            trigger: 'ingest',
            verdict: councilResult.verdict,
            seats: councilResult.seats,
            catfish: councilResult.catfish,
            revisedAfterCatfish: councilResult.revisedAfterCatfish,
            missingSeats: councilResult.missingSeats,
            providersUsed: councilResult.providersUsed,
            errors: councilResult.errors,
            cost: councilResult.cost,
            extraContext: { convergences, signalCount: relatedSignals.length },
          });
          analysisId = rec ? rec.id : null;
        }

        const v = (councilResult && councilResult.verdict) || {};
        const base = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
        const link = base
          ? analysisId
            ? `\n\nFull Council debate: ${base}/analyses.html?id=${analysisId}`
            : `\n\nAll analyses: ${base}/analyses.html`
          : '';

        const councilRead = councilError
          ? `(Council unavailable: ${councilError.slice(0, 200)})`
          : `${v.verdict ? `Verdict: ${v.verdict}${v.conviction != null ? ` (conviction ${v.conviction}/10)` : ''}\n` : ''}${
              v.headline || ''
            }\n\n${v.keyTakeaway || ''}${
              v.councilDisagreements && v.councilDisagreements.toLowerCase() !== 'none'
                ? `\n\nWhere the Council split: ${v.councilDisagreements}`
                : ''
            }`;

        const text = `FinancialEdge — new convergence detected:\n\n${convergences
          .map((c) => `• ${c.ticker}: ${c.count} mentions in ${CONVERGENCE_WINDOW_DAYS}d${c.strongConvergence ? ' (strong)' : ''}`)
          .join('\n')}\n\n${councilRead}${link}`;
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
