'use strict';

/**
 * Decision Journal — the Brain's accountability layer.
 *
 * Every decision Yinon makes gets logged with the Council's read *at the time
 * it was made* (verdict, conviction, who agreed, who dissented). Later, when
 * the position closes, the entry is reconciled against what actually happened.
 *
 * The point is calibration: a conviction-9 BUY that loses money and a
 * conviction-4 WATCH that would have doubled are both worth knowing about.
 * Over time the scorecard shows whether the Council's confidence means
 * anything — and specifically whether a *split* Council is a warning sign,
 * which is the single most useful thing this can tell us.
 *
 * Read-only with respect to execution, like everything else here: the journal
 * records what Yinon did, it never does anything.
 */

const crypto = require('crypto');

const ACTIONS = ['BUY', 'SHORT', 'ADD', 'TRIM', 'EXIT', 'PASS', 'WATCH'];

function createEntry(input) {
  const action = String(input.action || '').toUpperCase();
  return {
    id: crypto.randomUUID(),
    ts: input.ts || new Date().toISOString(),
    ticker: String(input.ticker || '').toUpperCase(),
    action: ACTIONS.includes(action) ? action : 'BUY',
    side: input.side === 'short' ? 'short' : 'long',
    shares: input.shares != null ? Number(input.shares) : null,
    price: input.price != null ? Number(input.price) : null,
    stopPrice: input.stopPrice != null ? Number(input.stopPrice) : null,
    targetPrice: input.targetPrice != null ? Number(input.targetPrice) : null,
    thesis: input.thesis || '',
    conviction: input.conviction != null ? Number(input.conviction) : null,
    // Snapshot of what the Council thought when the call was made. Frozen —
    // never re-fetched, or we'd be grading against hindsight.
    council: input.council || null,
    positionId: input.positionId || null,
    source: input.source || 'manual',
    status: 'open',
    outcome: null,
  };
}

/**
 * Reconcile a decision against what actually happened.
 * `verdictLabel` is deliberately judged on realized P&L, not on whether the
 * story felt right.
 */
function closeEntry(entry, outcome) {
  const exitPrice = outcome.exitPrice != null ? Number(outcome.exitPrice) : null;
  const entryPrice = entry.price;
  const shares = outcome.shares != null ? Number(outcome.shares) : entry.shares;

  let pnlUsd = null;
  let pnlPct = null;
  if (exitPrice != null && entryPrice != null && shares != null) {
    // A closed short profits when price FALLS. Getting this sign wrong doesn't
    // just misreport one trade — it feeds an inverted outcome into the
    // scorecard and every calibration lesson built on it.
    const direction = entry.side === 'short' || entry.action === 'SHORT' ? -1 : 1;
    pnlUsd = (exitPrice - entryPrice) * shares * direction;
    pnlPct = entryPrice ? ((exitPrice - entryPrice) / entryPrice) * 100 * direction : null;
  }

  let result = outcome.result || null;
  if (!result && pnlUsd != null) {
    result = pnlUsd > 0 ? 'win' : pnlUsd < 0 ? 'loss' : 'flat';
  }

  return {
    ...entry,
    status: 'closed',
    outcome: {
      closedAt: outcome.closedAt || new Date().toISOString(),
      exitPrice,
      shares,
      pnlUsd: pnlUsd != null ? +pnlUsd.toFixed(2) : null,
      pnlPct: pnlPct != null ? +pnlPct.toFixed(2) : null,
      result,
      whatHappened: outcome.whatHappened || '',
      lesson: outcome.lesson || '',
      thesisHeld: outcome.thesisHeld != null ? Boolean(outcome.thesisHeld) : null,
    },
  };
}

/**
 * Track record. Sliced by the things that would actually change behaviour:
 * conviction level, Council alignment, and Council verdict.
 */
function scorecard(entries) {
  const closed = entries.filter((e) => e.status === 'closed' && e.outcome && e.outcome.result);
  const wins = closed.filter((e) => e.outcome.result === 'win');
  const losses = closed.filter((e) => e.outcome.result === 'loss');

  const totalPnl = closed.reduce((sum, e) => sum + (e.outcome.pnlUsd || 0), 0);
  const avgWin = wins.length ? wins.reduce((s, e) => s + (e.outcome.pnlUsd || 0), 0) / wins.length : null;
  const avgLoss = losses.length ? losses.reduce((s, e) => s + (e.outcome.pnlUsd || 0), 0) / losses.length : null;

  return {
    totalDecisions: entries.length,
    openDecisions: entries.filter((e) => e.status === 'open').length,
    closedDecisions: closed.length,
    wins: wins.length,
    losses: losses.length,
    hitRatePct: closed.length ? +((wins.length / closed.length) * 100).toFixed(1) : null,
    totalPnlUsd: +totalPnl.toFixed(2),
    avgWinUsd: avgWin != null ? +avgWin.toFixed(2) : null,
    avgLossUsd: avgLoss != null ? +avgLoss.toFixed(2) : null,
    // Expectancy per decision — the number that actually matters for a
    // concentrated, high-risk book.
    expectancyUsd: closed.length ? +(totalPnl / closed.length).toFixed(2) : null,
    byConviction: bucketBy(closed, (e) => convictionBucket(e.conviction)),
    byCouncilAlignment: bucketBy(closed, (e) => (e.council && e.council.alignment) || 'unknown'),
    byCouncilVerdict: bucketBy(closed, (e) => (e.council && e.council.verdict) || 'unknown'),
  };
}

function convictionBucket(c) {
  if (c == null) return 'unrecorded';
  if (c >= 8) return 'high (8-10)';
  if (c >= 5) return 'medium (5-7)';
  return 'low (1-4)';
}

function bucketBy(closed, keyFn) {
  const out = {};
  for (const e of closed) {
    const key = keyFn(e);
    if (!out[key]) out[key] = { n: 0, wins: 0, pnlUsd: 0 };
    out[key].n++;
    if (e.outcome.result === 'win') out[key].wins++;
    out[key].pnlUsd += e.outcome.pnlUsd || 0;
  }
  for (const key of Object.keys(out)) {
    const b = out[key];
    b.hitRatePct = b.n ? +((b.wins / b.n) * 100).toFixed(1) : null;
    b.pnlUsd = +b.pnlUsd.toFixed(2);
  }
  return out;
}

module.exports = { createEntry, closeEntry, scorecard, ACTIONS };
