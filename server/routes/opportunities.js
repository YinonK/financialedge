'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, updateContext } = require('../lib/store');
const { requireCronKey } = require('../lib/cronAuth');
const { runCronJob } = require('../lib/asyncCron');
const { huntCandidates } = require('../services/opportunityHunt');
const council = require('../services/council');
const { sendMessage } = require('../services/telegram');
const costTracker = require('../services/costTracker');
const { recordAnalysis } = require('../services/analysisStore');

const router = express.Router();

/**
 * Soft budget guard: tell Yinon when spend is trending toward his ceiling.
 * Never changes behaviour — his call, not ours.
 */
async function notifyBudgetIfNeeded() {
  try {
    const warning = costTracker.maybeBudgetWarning();
    if (warning) await sendMessage(warning.message);
  } catch (err) {
    console.error('[budget] warning check failed:', err.message);
  }
}

function appBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
}

// Daily opportunity hunt — cron-triggered. The Brain goes looking for setups
// rather than waiting to be asked. READ-ONLY: it proposes names to look at;
// Yinon decides and executes everything.
router.post('/', async (req, res) => {
  if (!requireCronKey(req, res)) return;

  // Cheap guards run BEFORE the async handoff, so the common "nothing to do"
  // case still gets a definitive answer in the response.
  const context = readContext();

  // opportunityHuntCadenceDays was stored and editable but read by nothing.
  // Same self-check pattern as position reviews: the cron fires daily, the
  // route decides whether a hunt is actually due. 0 disables the hunt.
  const cadenceDays =
    context.settings.opportunityHuntCadenceDays != null ? Number(context.settings.opportunityHuntCadenceDays) : 1;
  if (!cadenceDays || cadenceDays <= 0) {
    return res.json({ skipped: true, reason: 'opportunity hunt is disabled (cadence set to 0)' });
  }
  const lastHunt = (context.opportunities.history || []).slice(-1)[0];
  if (lastHunt && Date.now() - new Date(lastHunt.ts).getTime() < cadenceDays * 24 * 60 * 60 * 1000) {
    return res.json({ skipped: true, reason: `not due yet (cadence: every ${cadenceDays} day(s))` });
  }

  // A full Council hunt runs for minutes — acknowledge now, report by Telegram.
  return runCronJob('opportunity hunt', req, res, async () => {
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
      updateContext((ctx) => {
        ctx.opportunities.history.push(entry);
        if (ctx.opportunities.history.length > 90) ctx.opportunities.history.shift();
      });
      return entry;
    }

    // Full 8-seat Council — the same depth Research and Position Reviews get.
    // This used to run the older 3-analyst path, which is why alerts read
    // "Analyst A/B/C" with no named seats.
    //
    // Efficiency without cutting depth: the Fact-Checker seat is skipped ONLY
    // when there is genuinely nothing to fact-check — i.e. every candidate came
    // from Yahoo trending with no channel text containing claims. That is the
    // seat correctly having no work, not a seat being dropped to save money.
    const depth = council.depthForPath(context.settings, 'opportunityHunt');
    const anyChannelClaims = hunt.candidates.some((c) => c.hasChannelConviction);
    const roleIds = depth.light
      ? depth.roleIds
      : anyChannelClaims
      ? undefined // all seats
      : ['bull', 'bear', 'riskManager', 'macroAnalyst', 'sentimentAnalyst'];

    let councilResult = null;
    let councilError = null;
    try {
      const situation = `DAILY OPPORTUNITY HUNT — screening names Yinon does NOT currently hold.

These candidates came from two sources, and the difference matters a lot:
  - "channel signals" = mentioned in Yinon's own Telegram alpha channels. Real conviction from sources he chose.
  - "Yahoo trending" = surfaced purely because retail attention spiked. NO backing from his sources. Treat this as weak evidence on its own and say so plainly if that is all a name has.

Current book (for correlation and concentration): ${JSON.stringify(
        context.portfolio.positions.map((p) => p.ticker)
      )}

Candidates, with provenance and a real server-computed technical screen:
${JSON.stringify(hunt.candidates, null, 2)}
${
  anyChannelClaims
    ? ''
    : '\nNOTE: every candidate today is trending-sourced. None were mentioned in Yinon\'s channels. The Fact-Checker seat is not sitting for this run because there are no source claims to verify — say clearly that the evidence base here is thin.'
}

Which of these, if any, genuinely deserve his attention today? Be selective. Recommending everything is the same as recommending nothing, and a weak idea dressed up wastes his capital and his trust. If none are compelling, say so plainly — "nothing here today" is a valid and useful answer.

The CFO's verdict should cover the shortlist as a whole and name which single candidate (if any) is worth real work.`;

      councilResult = await council.convene(situation, {
        roleIds,
        catfish: depth.catfish,
        settings: context.settings,
        costLabel: 'opportunity hunt',
      });
    } catch (err) {
      console.error('[opportunities] council failed:', err.message);
      councilError = err.message;
    }

    // Persist the full debate before building the alert, so the alert can
    // deep-link straight to it.
    if (councilResult && councilResult.seats && councilResult.seats.length) {
      const rec = recordAnalysis({
        tickers: hunt.candidates.map((c) => c.ticker),
        ticker: hunt.candidates[0] ? hunt.candidates[0].ticker : null,
        kind: 'opportunity',
        trigger: 'scheduled',
        verdict: councilResult.verdict,
        seats: councilResult.seats,
        catfish: councilResult.catfish,
        revisedAfterCatfish: councilResult.revisedAfterCatfish,
        missingSeats: councilResult.missingSeats,
        providersUsed: councilResult.providersUsed,
        errors: councilResult.errors,
        cost: councilResult.cost,
        extraContext: { candidates: hunt.candidates, screened: hunt.screened },
      });
      if (rec) councilResult.__analysisId = rec.id;
    }

    const v = (councilResult && councilResult.verdict) || {};
    const councilRead = councilError
      ? `(Council unavailable: ${councilError.slice(0, 200)})`
      : `${v.headline || ''}\n\n${v.keyTakeaway || ''}${
          v.councilDisagreements && v.councilDisagreements.toLowerCase() !== 'none'
            ? `\n\nWhere the Council split: ${v.councilDisagreements}`
            : ''
        }`;

    const base = appBaseUrl();
    const analysisLink =
      base && councilResult && councilResult.__analysisId
        ? `\n\nFull debate: ${base}/analyses.html?id=${councilResult.__analysisId}`
        : base
        ? `\n\nAll analyses: ${base}/analyses.html`
        : '';

    const text = `FinancialEdge — Daily Opportunity Hunt

${hunt.candidates
  .map(
    (c) =>
      `• ${c.ticker} — score ${c.score}\n  ${c.provenance}\n  ${c.reasons.slice(0, 3).join('; ')}`
  )
  .join('\n')}

${v.verdict ? `Council verdict: ${v.verdict}${v.conviction != null ? ` (conviction ${v.conviction}/10)` : ''}\n` : ''}${councilRead}${analysisLink}`;

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
      verdict: councilResult ? councilResult.verdict : null,
      analysisId: councilResult ? councilResult.__analysisId : null,
      cost: councilResult ? councilResult.cost : null,
      delivery,
    };
    // Applied to the live context — the Council run above took minutes, and
    // writing back the pre-run snapshot used to erase everything ingested
    // meanwhile (including the analysis recorded seconds ago).
    updateContext((ctx) => {
      ctx.opportunities.history.push(entry);
      if (ctx.opportunities.history.length > 90) ctx.opportunities.history.shift();
    });

    await notifyBudgetIfNeeded();

    return entry;
  });
});

router.get('/history', (req, res) => {
  const context = readContext();
  res.json(context.opportunities.history);
});

module.exports = router;
