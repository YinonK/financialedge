'use strict';

/**
 * Portfolio Council Review — re-underwriting an open position.
 *
 * Distinct from the two things that already exist:
 *   - Watchdog     — price mechanics only. Has it hit the stop? Broken a level?
 *   - Weekly Review— backward-looking summary of what happened.
 *
 * This is forward-looking and thesis-based. It asks the one question neither
 * of those asks: *we believed something specific when we entered — is that
 * still true?* A position can sit comfortably between its stop and target,
 * never triggering the watchdog, while the reason for owning it quietly
 * dies. That's the failure this catches.
 *
 * READ-ONLY. Produces a recommendation. Never sells anything.
 */

const { getQuote, getTechnicals } = require('./yahooFinance');
const { getValuation } = require('./valuation');
const { getFlowSentiment } = require('./flowSentiment');
const { getIndicators } = require('./marketIndicators');
const { computeZone } = require('./riskPortfolio');
const council = require('./council');

// The thesis-status fields the standard CFO verdict doesn't carry.
const REVIEW_CHAIR_FIELDS = `  "thesisStatus": "INTACT"|"WEAKENING"|"BROKEN",
  "whatChangedSinceEntry": string,      // concrete changes since entry, or "nothing material"
  "thesisStatusReasoning": string,      // why that status specifically
  "originalThesisHeldUp": boolean       // did the reason we entered actually play out so far`;

const LOOKBACK_SIGNAL_DAYS = 21;

/**
 * Finds the journal entry that opened this position, so the Council is
 * arguing against what we actually believed rather than a reconstruction.
 */
function findEntryDecision(context, position) {
  const entries = (context.journal && context.journal.entries) || [];
  return (
    entries.find((e) => e.positionId === position.id) ||
    entries
      .filter((e) => e.ticker === position.ticker)
      .sort((a, b) => new Date(a.ts) - new Date(b.ts))[0] ||
    null
  );
}

function recentSignalsFor(context, ticker, days = LOOKBACK_SIGNAL_DAYS) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return (context.signals.items || [])
    .filter((s) => new Date(s.pastedAt).getTime() >= cutoff)
    .filter((s) => (s.tickers || []).includes(ticker))
    .slice(-10);
}

async function safe(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Runs a full Council re-underwriting of one position.
 *
 * @param {object} position   the open position
 * @param {object} context    full app context (journal, signals, portfolio)
 * @param {object} opts       { trigger: 'scheduled'|'event'|'manual', eventReason }
 */
async function reviewPosition(position, context, opts = {}) {
  if (!council.anyConfigured()) {
    const err = new Error('No AI provider configured — cannot run a Council review.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const entryDecision = findEntryDecision(context, position);

  const [quote, technicals, valuation, flow, indicators] = await Promise.all([
    safe(() => getQuote(position.ticker)),
    safe(() => getTechnicals(position.ticker)),
    safe(() => getValuation(position.ticker)),
    safe(() => getFlowSentiment(position.ticker)),
    safe(() => getIndicators(context.indicators && context.indicators.thresholds)),
  ]);

  const currentPrice = quote.ok ? quote.value.price : null;
  const zone = currentPrice != null ? computeZone(position, currentPrice) : null;
  const dir = position.side === 'short' ? -1 : 1;
  const pnlUsd =
    currentPrice != null ? (currentPrice - position.entryPrice) * position.shares * dir : null;
  const pnlPct =
    currentPrice != null && position.entryPrice
      ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100 * dir
      : null;

  const heldDays = position.entryDate
    ? Math.round((Date.now() - new Date(position.entryDate).getTime()) / (24 * 60 * 60 * 1000))
    : null;

  const newSignals = recentSignalsFor(context, position.ticker);

  const situation = `PORTFOLIO COUNCIL REVIEW — re-underwriting an OPEN position Yinon already holds.

This is not a fresh idea. He is already in it. The question is not "is this a good buy?" but: **we believed something specific when we entered — is that still true, and has anything happened since that breaks or weakens it?**

=== WHAT WE BELIEVED AT ENTRY ===
${
  entryDecision
    ? JSON.stringify(
        {
          enteredOn: entryDecision.ts,
          action: entryDecision.action,
          entryPrice: entryDecision.price,
          thesisAtEntry: entryDecision.thesis || '(no thesis recorded)',
          yinonsConvictionAtEntry: entryDecision.conviction,
          councilAtEntry: entryDecision.council || '(no Council read recorded at entry)',
        },
        null,
        2
      )
    : '(No decision journal entry found for this position — we have no record of the original thesis. Say so explicitly and reason from the position parameters alone; do not invent a thesis we never wrote down.)'
}

=== THE POSITION NOW ===
${JSON.stringify(
  {
    ticker: position.ticker,
    side: position.side,
    shares: position.shares,
    entryPrice: position.entryPrice,
    stopPrice: position.stopPrice,
    targetPrice: position.targetPrice,
    entryDate: position.entryDate,
    heldForDays: heldDays,
    currentPrice,
    unrealizedPnlUsd: pnlUsd != null ? +pnlUsd.toFixed(2) : null,
    unrealizedPnlPct: pnlPct != null ? +pnlPct.toFixed(2) : null,
    stopTargetZone: zone,
    positionNotes: position.notes || '',
  },
  null,
  2
)}

=== REVIEW TRIGGER ===
${
  opts.trigger === 'event'
    ? `Event-triggered: ${opts.eventReason || 'a material event was detected for this ticker'}. Weight that event heavily — it is why this review is running now.`
    : opts.trigger === 'manual'
    ? 'Manually requested by Yinon.'
    : 'Scheduled periodic review — looking for slow thesis decay, not a single dramatic event. Absence of drama is not evidence the thesis is fine.'
}

=== CURRENT DATA (server-fetched, real) ===
Technicals: ${technicals.ok ? JSON.stringify(technicals.value, null, 2) : `unavailable (${technicals.error})`}

Valuation: ${valuation.ok ? JSON.stringify(valuation.value, null, 2) : `unavailable (${valuation.error})`}

Flow & sentiment: ${flow.ok ? JSON.stringify(flow.value, null, 2) : `unavailable (${flow.error})`}

Macro indicators: ${
    indicators.ok
      ? JSON.stringify(
          {
            redCount: indicators.value.redCount,
            confluenceAlert: indicators.value.confluenceAlert,
            indicators: indicators.value.indicators.map((i) => ({ id: i.id, status: i.status, value: i.value })),
          },
          null,
          2
        )
      : `unavailable (${indicators.error})`
  }

=== SIGNALS MENTIONING THIS TICKER (last ${LOOKBACK_SIGNAL_DAYS} days) ===
${newSignals.length ? JSON.stringify(newSignals, null, 2) : 'none'}

=== REST OF THE BOOK (correlation context) ===
${JSON.stringify((context.portfolio.positions || []).filter((p) => p.id !== position.id).map((p) => p.ticker))}

Every seat: argue your mandate against THIS position as it stands today. The Risk Manager should weigh in on whether the original stop still makes sense given what's changed. The CFO must return an explicit thesis status.

Data marked unavailable has NO feed — reason around the gap, never invent numbers.`;

  const result = await council.conveneWithMemory(situation, context, position.ticker, {
    extraChairFields: REVIEW_CHAIR_FIELDS,
    settings: context.settings,
    costLabel: `position review (${position.ticker})`,
  });

  return {
    positionId: position.id,
    ticker: position.ticker,
    trigger: opts.trigger || 'scheduled',
    eventReason: opts.eventReason || null,
    reviewedAt: new Date().toISOString(),
    snapshot: {
      currentPrice,
      unrealizedPnlUsd: pnlUsd != null ? +pnlUsd.toFixed(2) : null,
      unrealizedPnlPct: pnlPct != null ? +pnlPct.toFixed(2) : null,
      heldDays,
      zone,
    },
    hadEntryThesis: Boolean(entryDecision),
    verdict: result.verdict,
    cost: result.cost,
    seats: result.seats,
    catfish: result.catfish,
    revisedAfterCatfish: result.revisedAfterCatfish,
    missingSeats: result.missingSeats,
    providersUsed: result.providersUsed,
    errors: result.errors,
  };
}

/**
 * Which positions are due a scheduled review, based on the user-configured
 * cadence. This is why a single daily cron tick can serve any cadence — the
 * job asks each position "has it been N days since you were last reviewed?"
 * rather than the schedule itself encoding the cadence.
 */
function positionsDueForReview(context, nowMs = Date.now()) {
  const cadenceDays =
    (context.settings && context.settings.positionReviewCadenceDays) != null
      ? Number(context.settings.positionReviewCadenceDays)
      : 3;

  // 0 or negative disables scheduled reviews entirely (event triggers still fire).
  if (!cadenceDays || cadenceDays <= 0) return { cadenceDays, due: [] };

  const lastReviewed = (context.positionReviews && context.positionReviews.lastReviewedAt) || {};
  const cadenceMs = cadenceDays * 24 * 60 * 60 * 1000;

  const due = (context.portfolio.positions || []).filter((p) => {
    const last = lastReviewed[p.id];
    if (!last) return true; // never reviewed
    return nowMs - new Date(last).getTime() >= cadenceMs;
  });

  return { cadenceDays, due };
}

module.exports = { reviewPosition, positionsDueForReview, findEntryDecision, REVIEW_CHAIR_FIELDS };
