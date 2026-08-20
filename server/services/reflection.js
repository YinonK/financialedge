'use strict';

/**
 * Reflection injection — what turns this from a stateless analyzer into
 * something that remembers being wrong.
 *
 * Before the Council debates a name, we hand it two things drawn from the
 * decision journal:
 *   1. What we said about THIS ticker before, and how it actually played out.
 *   2. A cross-ticker lesson, if the track record actually supports one.
 *
 * This costs nothing — it's added context, not an extra model call.
 *
 * The important discipline here is sample size. With three closed trades,
 * "split-Council calls underperform" is noise dressed as insight, and feeding
 * it to the Council would make it *worse* calibrated, not better. So every
 * claim below is gated on a minimum N and stated with its sample size
 * attached, so the models can weight it honestly.
 */

const journal = require('./journal');

// Below this, a "pattern" is indistinguishable from chance and we say nothing.
const MIN_SAMPLE_FOR_PATTERN = 6;
const MIN_PER_BUCKET = 3;

function formatOutcome(e) {
  if (e.status !== 'closed' || !e.outcome) return 'still open';
  const o = e.outcome;
  const pnl = o.pnlUsd != null ? `${o.pnlUsd >= 0 ? '+' : ''}$${o.pnlUsd}` : 'P&L unrecorded';
  const pct = o.pnlPct != null ? ` (${o.pnlPct >= 0 ? '+' : ''}${o.pnlPct}%)` : '';
  return `${o.result || 'closed'} ${pnl}${pct}${o.lesson ? ` — lesson recorded: "${o.lesson}"` : ''}`;
}

/**
 * Per-ticker history: what the Council said, and what happened.
 */
function tickerHistory(entries, ticker) {
  if (!ticker) return null;
  const t = String(ticker).toUpperCase();
  const past = entries
    .filter((e) => e.ticker === t)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  if (!past.length) return null;

  const lines = past.slice(-5).map((e) => {
    const c = e.council || {};
    const councilBit = c.verdict
      ? `Council said ${c.verdict}${c.conviction != null ? ` at conviction ${c.conviction}/10` : ''}${
          c.alignment ? `, ${c.alignment}` : ''
        }`
      : 'no Council read recorded';
    return `- ${new Date(e.ts).toISOString().slice(0, 10)}: ${e.action}${
      e.price != null ? ` @ $${e.price}` : ''
    }. ${councilBit}. Outcome: ${formatOutcome(e)}.`;
  });

  return `We have looked at ${t} before (${past.length} prior decision${past.length === 1 ? '' : 's'}):\n${lines.join('\n')}`;
}

/**
 * Cross-ticker calibration lesson — only where the sample supports it.
 * Returns null rather than manufacturing a pattern from thin data.
 */
function calibrationLesson(entries) {
  const stats = journal.scorecard(entries);
  if (!stats.closedDecisions || stats.closedDecisions < MIN_SAMPLE_FOR_PATTERN) {
    return stats.closedDecisions
      ? `Track record so far: ${stats.closedDecisions} closed decision${
          stats.closedDecisions === 1 ? '' : 's'
        } — too few to draw calibration lessons from yet. Do not treat this as a pattern.`
      : null;
  }

  const notes = [];

  // Does Council alignment predict anything?
  const align = stats.byCouncilAlignment || {};
  const unanimous = align.unanimous;
  const split = align.split;
  if (
    unanimous &&
    split &&
    unanimous.n >= MIN_PER_BUCKET &&
    split.n >= MIN_PER_BUCKET &&
    unanimous.hitRatePct != null &&
    split.hitRatePct != null
  ) {
    const gap = unanimous.hitRatePct - split.hitRatePct;
    if (Math.abs(gap) >= 15) {
      notes.push(
        gap > 0
          ? `Unanimous Council calls have hit ${unanimous.hitRatePct}% (n=${unanimous.n}) versus ${split.hitRatePct}% for split calls (n=${split.n}). Council disagreement has been a genuine warning sign here — weight it.`
          : `Split Council calls have actually hit ${split.hitRatePct}% (n=${split.n}) versus ${unanimous.hitRatePct}% for unanimous ones (n=${unanimous.n}). Unanimity has NOT meant safety in this book — be wary of easy agreement.`
      );
    }
  }

  // Does conviction predict anything?
  const conv = stats.byConviction || {};
  const high = conv['high (8-10)'];
  const low = conv['low (1-4)'];
  const mid = conv['medium (5-7)'];
  const highBucket = high && high.n >= MIN_PER_BUCKET ? high : null;
  const lowerBucket =
    low && low.n >= MIN_PER_BUCKET ? low : mid && mid.n >= MIN_PER_BUCKET ? mid : null;
  if (highBucket && lowerBucket && highBucket.hitRatePct != null && lowerBucket.hitRatePct != null) {
    const gap = highBucket.hitRatePct - lowerBucket.hitRatePct;
    if (gap < 0) {
      notes.push(
        `High-conviction calls have hit ${highBucket.hitRatePct}% (n=${highBucket.n}) — WORSE than lower-conviction ones at ${lowerBucket.hitRatePct}%. Confidence has been anti-predictive so far. Treat a high conviction score as a reason to look harder, not to relax.`
      );
    } else if (gap >= 20) {
      notes.push(
        `High-conviction calls have hit ${highBucket.hitRatePct}% (n=${highBucket.n}) versus ${lowerBucket.hitRatePct}% for lower conviction. Conviction has carried real signal here.`
      );
    }
  }

  // Overall expectancy is worth stating plainly either way.
  if (stats.expectancyUsd != null) {
    notes.push(
      `Overall: ${stats.closedDecisions} closed, ${stats.hitRatePct}% hit rate, $${stats.expectancyUsd} expectancy per decision.`
    );
  }

  return notes.length ? notes.join(' ') : null;
}

/**
 * Builds the reflection block injected into Council context.
 * Returns '' when there's nothing honest to say.
 */
function buildReflection(context, ticker) {
  const entries = (context && context.journal && context.journal.entries) || [];
  if (!entries.length) return '';

  const parts = [];
  const history = tickerHistory(entries, ticker);
  if (history) parts.push(history);

  const lesson = calibrationLesson(entries);
  if (lesson) parts.push(lesson);

  if (!parts.length) return '';

  return `=== REFLECTION: OUR OWN TRACK RECORD ===
${parts.join('\n\n')}

Use this. If we were wrong about this name before, say what is different this time — or admit that nothing is. Do not repeat a mistake the record already shows us making.`;
}

module.exports = { buildReflection, tickerHistory, calibrationLesson };
