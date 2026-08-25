'use strict';

/**
 * Unified analysis store — the Brain's actual memory.
 *
 * Before this existed, only position reviews kept their transcript. A
 * research call cost ~8 model calls and three minutes of genuine adversarial
 * debate, rendered once in the browser, and was then gone forever. Anything
 * the Council thought about a name it never traded left no trace at all, so
 * the fourth look at a ticker started as blank as the first.
 *
 * Every Council path now writes here through one function, which gives us:
 *   - a browsable, permalinkable record of every debate
 *   - reflection that draws on ALL prior looks, not just closed trades
 *   - a per-ticker timeline showing how the view actually evolved
 *
 * Kinds: 'research' | 'convergence' | 'opportunity' | 'position_review'
 */

const crypto = require('crypto');
const { updateContext } = require('../lib/store');

const MAX_ANALYSES = 400;

/**
 * Normalises the different Council shapes into one record. Callers pass what
 * they have; missing pieces are simply absent rather than faked.
 */
function buildRecord({
  ticker,
  tickers,
  kind,
  trigger,
  verdict,
  seats,
  catfish,
  revisedAfterCatfish,
  missingSeats,
  providersUsed,
  errors,
  cost,
  context: extraContext,
  summaryText,
}) {
  const v = verdict || {};
  return {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    kind,
    trigger: trigger || null,
    // Primary ticker for timeline grouping; `tickers` holds all names the run covered.
    ticker: ticker ? String(ticker).toUpperCase() : null,
    tickers: (tickers || (ticker ? [ticker] : [])).map((t) => String(t).toUpperCase()),

    // Headline fields promoted for cheap listing/filtering without parsing the blob.
    verdictLabel: v.verdict || null,
    conviction: v.conviction != null ? v.conviction : null,
    thesisStatus: v.thesisStatus || null,
    councilAlignment: v.councilAlignment || null,
    headline: v.headline || null,
    keyTakeaway: v.keyTakeaway || null,

    // Full record.
    verdict: v,
    seats: seats || [],
    catfish: catfish || null,
    revisedAfterCatfish: Boolean(revisedAfterCatfish),
    missingSeats: missingSeats || [],
    providersUsed: providersUsed || [],
    errors: errors || [],
    cost: cost || null,
    extraContext: extraContext || null,
    summaryText: summaryText || null,
  };
}

/**
 * Persists an analysis, applied to the live context so parallel runs can't
 * clobber each other.
 */
function recordAnalysis(payload) {
  try {
    const record = buildRecord(payload);
    updateContext((context) => {
      context.analyses.history.push(record);
      if (context.analyses.history.length > MAX_ANALYSES) context.analyses.history.shift();
    });
    return record;
  } catch (err) {
    // Never let a bookkeeping failure break an analysis that already succeeded.
    console.error('[analysisStore] failed to record analysis:', err.message);
    return null;
  }
}

function listAnalyses(context, { ticker, kind, verdict, limit = 100, offset = 0 } = {}) {
  let items = [...(context.analyses.history || [])].sort((a, b) => new Date(b.ts) - new Date(a.ts));
  if (ticker) {
    const t = String(ticker).toUpperCase();
    items = items.filter((a) => a.ticker === t || (a.tickers || []).includes(t));
  }
  if (kind) items = items.filter((a) => a.kind === kind);
  if (verdict) items = items.filter((a) => a.verdictLabel === String(verdict).toUpperCase());
  return { total: items.length, items: items.slice(offset, offset + limit) };
}

function getAnalysis(context, id) {
  return (context.analyses.history || []).find((a) => a.id === id) || null;
}

/**
 * Per-ticker timeline: how the Council's view actually moved over time.
 * This is the "we said WATCH 4, then WATCH 5, then BUY 7 — here's what
 * changed" view.
 */
function tickerTimeline(context, ticker) {
  const t = String(ticker).toUpperCase();
  const analyses = (context.analyses.history || [])
    .filter((a) => a.ticker === t || (a.tickers || []).includes(t))
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  const points = analyses.map((a) => ({
    id: a.id,
    ts: a.ts,
    kind: a.kind,
    trigger: a.trigger,
    verdict: a.verdictLabel,
    conviction: a.conviction,
    thesisStatus: a.thesisStatus,
    alignment: a.councilAlignment,
    headline: a.headline,
    revisedAfterCatfish: a.revisedAfterCatfish,
  }));

  // Journal decisions on this ticker, so the timeline shows what was actually
  // DONE alongside what was said.
  const decisions = ((context.journal && context.journal.entries) || [])
    .filter((e) => e.ticker === t)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    .map((e) => ({
      id: e.id,
      ts: e.ts,
      action: e.action,
      price: e.price,
      conviction: e.conviction,
      status: e.status,
      outcome: e.outcome
        ? { result: e.outcome.result, pnlUsd: e.outcome.pnlUsd, pnlPct: e.outcome.pnlPct, closedAt: e.outcome.closedAt }
        : null,
    }));

  // Did the view drift? Only meaningful with 2+ looks.
  let evolution = null;
  if (points.length >= 2) {
    const first = points[0];
    const last = points[points.length - 1];
    const convDelta =
      first.conviction != null && last.conviction != null ? last.conviction - first.conviction : null;
    evolution = {
      firstLookAt: first.ts,
      latestLookAt: last.ts,
      looks: points.length,
      verdictPath: points.map((p) => p.verdict).filter(Boolean),
      convictionPath: points.map((p) => p.conviction).filter((c) => c != null),
      convictionDelta: convDelta,
      verdictChanged: first.verdict !== last.verdict,
      direction:
        convDelta == null ? 'unknown' : convDelta > 0 ? 'warming' : convDelta < 0 ? 'cooling' : 'flat',
    };
  }

  return { ticker: t, points, decisions, evolution };
}

module.exports = { recordAnalysis, listAnalyses, getAnalysis, tickerTimeline, MAX_ANALYSES };
