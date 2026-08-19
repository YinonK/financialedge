'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, writeContext } = require('../lib/store');
const { requireCronKey } = require('../lib/cronAuth');
const { huntCandidates } = require('../services/opportunityHunt');
const council = require('../services/council');
const { SYSTEM_PERSONA } = require('../services/brain');
const { sendMessage } = require('../services/telegram');

const router = express.Router();

// Daily opportunity hunt — cron-triggered. The Brain goes looking for setups
// rather than waiting to be asked. READ-ONLY: it proposes names to look at;
// Yinon decides and executes everything.
router.post('/', async (req, res) => {
  if (!requireCronKey(req, res)) return;

  try {
    const context = readContext();
    const hunt = await huntCandidates(context);

    if (!hunt.candidates.length) {
      const entry = {
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        candidates: [],
        councilRead: null,
        note: hunt.note || 'No candidates passed screening today.',
        delivery: null,
      };
      context.opportunities.history.push(entry);
      if (context.opportunities.history.length > 90) context.opportunities.history.shift();
      writeContext(context);
      return res.json(entry);
    }

    // Full Council brainstorm on the shortlist — same treatment convergences get.
    let councilRead = null;
    try {
      const brainstorm = await council.brainstormSignals(
        SYSTEM_PERSONA,
        `Daily opportunity hunt. These candidates surfaced from Yinon's own channel signal flow and market trending data, screened on real server-computed technicals. He does NOT currently hold any of them.

Current book (for correlation/concentration context): ${JSON.stringify(
          context.portfolio.positions.map((p) => p.ticker)
        )}

Candidates with their screen results:
${JSON.stringify(hunt.candidates, null, 2)}

Which of these, if any, actually deserve Yinon's attention today? Be selective — recommending everything is the same as recommending nothing. If none are compelling, say so plainly.`
      );
      councilRead = brainstorm.text;
    } catch (err) {
      console.error('[opportunities] council brainstorm failed:', err.message);
      councilRead = `(Council brainstorm failed: ${err.message.slice(0, 200)})`;
    }

    const text = `FinancialEdge — Daily Opportunity Hunt\n\n${hunt.candidates
      .map((c) => `• ${c.ticker} (score ${c.score}, via ${c.origin})\n  ${c.reasons.slice(0, 3).join('; ')}`)
      .join('\n')}\n\n${councilRead || ''}`;

    const delivery = await sendMessage(text).catch((err) => {
      console.error('[opportunities] alert send failed:', err.message);
      return { delivered: false, error: err.message };
    });

    const entry = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      candidates: hunt.candidates,
      screened: hunt.screened,
      dataFailures: hunt.dataFailures,
      councilRead,
      delivery,
    };
    context.opportunities.history.push(entry);
    if (context.opportunities.history.length > 90) context.opportunities.history.shift();
    writeContext(context);

    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history', (req, res) => {
  const context = readContext();
  res.json(context.opportunities.history);
});

module.exports = router;
