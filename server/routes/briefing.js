'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, updateContext } = require('../lib/store');
const { getIndicators } = require('../services/marketIndicators');
const { getUsdIls } = require('../services/fx');
const { getQuote } = require('../services/yahooFinance');
const council = require('../services/council');
const costTracker = require('../services/costTracker');
const { sendBriefing } = require('../services/telegram');
const { SYSTEM_PERSONA } = require('../services/brain');
const { requireCronKey, reportCronFailure } = require('../lib/cronAuth');

const router = express.Router();

// Triggered by cron-job.org on weekday mornings (07:30 Israel time). Render's
// free tier sleeps when idle, so this endpoint IS the wake-up call — see README.
// Protected by a shared secret so randoms on the internet can't spam it.
router.post('/', async (req, res) => {
  if (!requireCronKey(req, res)) return;

  try {
    const context = readContext();
    const [indicators, fx, positionsQuotes] = await Promise.all([
      getIndicators(context.indicators.thresholds),
      safeFx(),
      Promise.allSettled(context.portfolio.positions.map((p) => getQuote(p.ticker))),
    ]);

    const positionsLines = context.portfolio.positions.map((p, i) => {
      const q = positionsQuotes[i];
      if (q.status !== 'fulfilled') return `${p.ticker}: quote unavailable`;
      const dir = p.side === 'short' ? -1 : 1;
      const pnl = (q.value.price - p.entryPrice) * p.shares * dir;
      return `${p.ticker} ${p.side}: ${p.shares}sh @ ${p.entryPrice} -> now ${q.value.price.toFixed(2)} (P&L $${pnl.toFixed(2)})`;
    });

    const redFlags = indicators.indicators.filter((i) => i.status === 'red').map((i) => i.label);

    let narrative = null;
    if (council.anyConfigured()) {
      const prompt = `Write a short, sharp morning briefing (under 200 words) for Yinon.

Market indicators red flags today: ${redFlags.length ? redFlags.join(', ') : 'none'}
Confluence alert: ${indicators.confluenceAlert}
Current positions:\n${positionsLines.join('\n') || 'none open'}

Tone: sharp Wall Street friend, no disclaimers. Flag anything that needs his attention today. If nothing urgent, say so briefly and move on.`;
      try {
        narrative = await costTracker.metered('morning briefing', context.settings, (onUsage) =>
          council.chairGenerate(SYSTEM_PERSONA, [{ role: 'user', content: prompt }], {
            json: false,
            maxOutputTokens: 2048, // thinking models spend reasoning tokens from this budget
            onUsage,
          })
        );
      } catch (err) {
        narrative = `(Brain narrative unavailable: ${err.message})`;
      }
    } else {
      narrative =
        'No AI provider configured — raw data only. Add GEMINI_API_KEY (free), ANTHROPIC_API_KEY, or OPENAI_API_KEY to get The Brain\'s narrative take.';
    }

    const summaryText = `FinancialEdge Morning Briefing — ${new Date().toISOString().slice(0, 10)}

${narrative}

Red flags: ${redFlags.length ? redFlags.join(', ') : 'none'}
Positions:
${positionsLines.join('\n') || 'none open'}
USD/ILS: ${fx.rate || 'unavailable'}`;

    const delivery = await sendBriefing(summaryText);

    const entry = { id: crypto.randomUUID(), ts: new Date().toISOString(), summary: summaryText, delivery };
    updateContext((ctx) => {
      ctx.briefing.history.push(entry);
      if (ctx.briefing.history.length > 90) ctx.briefing.history.shift();
    });

    res.json(entry);
  } catch (err) {
    await reportCronFailure('morning briefing', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/history', (req, res) => {
  const context = readContext();
  res.json(context.briefing.history);
});

async function safeFx() {
  try {
    return await getUsdIls();
  } catch (err) {
    return { rate: null, error: err.message };
  }
}

module.exports = router;
