'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, writeContext } = require('../lib/store');
const { requireCronKey } = require('../lib/cronAuth');
const { getQuote } = require('../services/yahooFinance');
const { getUsdIls } = require('../services/fx');
const journalService = require('../services/journal');
const council = require('../services/council');
const { SYSTEM_PERSONA } = require('../services/brain');
const { sendMessage } = require('../services/telegram');

const router = express.Router();

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Saturday weekly review — cron-triggered. A deliberate look back before the
// next week starts. READ-ONLY, like everything else.
router.post('/weekly', async (req, res) => {
  if (!requireCronKey(req, res)) return;

  try {
    const context = readContext();
    const since = Date.now() - WEEK_MS;
    const weekOf = new Date().toISOString().slice(0, 10);

    // --- Journal activity this week ---
    const entries = context.journal.entries || [];
    const openedThisWeek = entries.filter((e) => new Date(e.ts).getTime() >= since);
    const closedThisWeek = entries.filter(
      (e) => e.status === 'closed' && e.outcome && new Date(e.outcome.closedAt).getTime() >= since
    );

    const realizedPnl = closedThisWeek.reduce((sum, e) => sum + ((e.outcome && e.outcome.pnlUsd) || 0), 0);

    // --- Open positions and unrealized P&L ---
    const positions = context.portfolio.positions || [];
    const [quotes, fx] = await Promise.all([
      Promise.allSettled(positions.map((p) => getQuote(p.ticker))),
      getUsdIls().catch(() => ({ rate: null })),
    ]);

    const positionLines = positions.map((p, i) => {
      const q = quotes[i];
      if (q.status !== 'fulfilled') return `${p.ticker}: quote unavailable`;
      const dir = p.side === 'short' ? -1 : 1;
      const pnl = (q.value.price - p.entryPrice) * p.shares * dir;
      const pnlPct = p.entryPrice ? ((q.value.price - p.entryPrice) / p.entryPrice) * 100 * dir : 0;
      return `${p.ticker} ${p.side}: ${p.shares}sh @ ${p.entryPrice} → ${q.value.price.toFixed(2)} (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(
        2
      )}, ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`;
    });

    const unrealizedPnl = positions.reduce((sum, p, i) => {
      const q = quotes[i];
      if (q.status !== 'fulfilled') return sum;
      const dir = p.side === 'short' ? -1 : 1;
      return sum + (q.value.price - p.entryPrice) * p.shares * dir;
    }, 0);

    // --- Signals this week ---
    const signalsThisWeek = (context.signals.items || []).filter(
      (s) => new Date(s.pastedAt).getTime() >= since
    );
    const tickerCounts = new Map();
    for (const s of signalsThisWeek) {
      for (const t of s.tickers || []) tickerCounts.set(t, (tickerCounts.get(t) || 0) + 1);
    }
    const topSignals = [...tickerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

    const scorecard = journalService.scorecard(entries);

    // --- The Brain's reflection ---
    let reflection = null;
    if (council.anyConfigured()) {
      const prompt = `Write Yinon's Saturday weekly review. Be direct and specific — this is a look back that should change how next week goes, not a status report.

Week of ${weekOf}

Decisions opened this week: ${JSON.stringify(
        openedThisWeek.map((e) => ({ ticker: e.ticker, action: e.action, conviction: e.conviction, thesis: e.thesis })),
        null,
        2
      )}

Decisions closed this week (with the Council's read at the time vs what actually happened):
${JSON.stringify(
  closedThisWeek.map((e) => ({
    ticker: e.ticker,
    action: e.action,
    conviction: e.conviction,
    council: e.council,
    thesis: e.thesis,
    outcome: e.outcome,
  })),
  null,
  2
)}

Realized P&L this week: $${realizedPnl.toFixed(2)}
Open positions: ${positionLines.join(' | ') || 'none'}
Unrealized P&L: $${unrealizedPnl.toFixed(2)}

Overall track record to date: ${JSON.stringify(scorecard, null, 2)}

Most-mentioned tickers across his channels this week: ${JSON.stringify(topSignals)}

Cover: what actually happened, what the track record says about calibration (especially whether conviction and Council agreement are predicting anything), what he should be watching into next week, and one thing worth doing differently. Under 300 words. No disclaimers, no filler.`;

      try {
        reflection = await council.chairGenerate(SYSTEM_PERSONA, [{ role: 'user', content: prompt }], {
          json: false,
          maxOutputTokens: 2048,
        });
      } catch (err) {
        reflection = `(Brain reflection unavailable: ${err.message.slice(0, 200)} — check Home → Brain Operations.)`;
      }
    } else {
      reflection = 'No AI provider configured — raw numbers only.';
    }

    const summary = `FinancialEdge — Weekly Review (week of ${weekOf})

${reflection}

── Numbers ──
Realized P&L this week: $${realizedPnl.toFixed(2)}${fx.rate ? ` (₪${(realizedPnl * fx.rate).toFixed(2)})` : ''}
Unrealized P&L: $${unrealizedPnl.toFixed(2)}${fx.rate ? ` (₪${(unrealizedPnl * fx.rate).toFixed(2)})` : ''}
Decisions opened: ${openedThisWeek.length} · closed: ${closedThisWeek.length}
Track record: ${scorecard.closedDecisions} closed, ${scorecard.hitRatePct != null ? scorecard.hitRatePct + '% hit rate' : 'no closed trades yet'}${
      scorecard.expectancyUsd != null ? `, $${scorecard.expectancyUsd}/decision expectancy` : ''
    }

Open positions:
${positionLines.join('\n') || 'none'}

Most-mentioned in your channels: ${topSignals.map(([t, n]) => `${t} (${n})`).join(', ') || 'nothing notable'}`;

    const delivery = await sendMessage(summary).catch((err) => {
      console.error('[review] send failed:', err.message);
      return { delivered: false, error: err.message };
    });

    const entry = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      weekOf,
      summary,
      realizedPnl: +realizedPnl.toFixed(2),
      unrealizedPnl: +unrealizedPnl.toFixed(2),
      openedCount: openedThisWeek.length,
      closedCount: closedThisWeek.length,
      delivery,
    };
    context.review.history.push(entry);
    if (context.review.history.length > 60) context.review.history.shift();
    writeContext(context);

    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history', (req, res) => {
  const context = readContext();
  res.json(context.review.history);
});

module.exports = router;
