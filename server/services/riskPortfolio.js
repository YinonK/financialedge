'use strict';

const { getSeries } = require('./yahooFinance');

/**
 * Risk & Portfolio Fit lens helpers. Read-only — this computes suggested
 * sizing and correlation flags for The Brain to *recommend*. Nothing here
 * ever places, modifies, or cancels an order. Yinon executes every trade.
 */

/**
 * Position size off stop distance, capped at maxRiskPct of account equity.
 */
function sizePosition({ accountEquity, entryPrice, stopPrice, maxRiskPct = 2 }) {
  if (!accountEquity || !entryPrice || !stopPrice || entryPrice === stopPrice) {
    return { error: 'accountEquity, entryPrice, and a stopPrice different from entryPrice are required' };
  }
  const stopDistance = Math.abs(entryPrice - stopPrice);
  const maxDollarRisk = accountEquity * (maxRiskPct / 100);
  const shares = Math.floor(maxDollarRisk / stopDistance);
  const positionCost = shares * entryPrice;
  const positionPctOfAccount = (positionCost / accountEquity) * 100;
  return {
    maxRiskPct,
    maxDollarRisk: +maxDollarRisk.toFixed(2),
    stopDistance: +stopDistance.toFixed(2),
    suggestedShares: shares,
    positionCost: +positionCost.toFixed(2),
    positionPctOfAccount: +positionPctOfAccount.toFixed(1),
  };
}

function dailyReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return out;
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const av = a.slice(a.length - n);
  const bv = b.slice(b.length - n);
  const meanA = av.reduce((x, y) => x + y, 0) / n;
  const meanB = bv.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = av[i] - meanA;
    const db = bv[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? null : num / den;
}

/**
 * Correlation of a candidate ticker's daily returns against each existing
 * position over the last ~90 trading days. Flags >0.7 as high correlation
 * (concentration risk for a ~5-position book).
 */
async function checkCorrelations(candidateSymbol, existingSymbols) {
  const uniqueSymbols = [...new Set(existingSymbols.filter((s) => s && s !== candidateSymbol))];
  if (uniqueSymbols.length === 0) return [];

  const allSymbols = [candidateSymbol, ...uniqueSymbols];
  const seriesResults = await Promise.allSettled(
    allSymbols.map((s) => getSeries(s, { range: '6mo', interval: '1d' }))
  );

  const candidateSeries = seriesResults[0];
  if (candidateSeries.status !== 'fulfilled') {
    return uniqueSymbols.map((s) => ({ symbol: s, correlation: null, error: 'candidate series unavailable' }));
  }
  const candidateReturns = dailyReturns(candidateSeries.value.close);

  return uniqueSymbols.map((symbol, idx) => {
    const res = seriesResults[idx + 1];
    if (res.status !== 'fulfilled') {
      return { symbol, correlation: null, error: res.reason ? res.reason.message : 'fetch failed' };
    }
    const corr = pearson(candidateReturns, dailyReturns(res.value.close));
    return {
      symbol,
      correlation: corr != null ? +corr.toFixed(2) : null,
      highCorrelation: corr != null ? Math.abs(corr) > 0.7 : false,
    };
  });
}

/**
 * Where a position sits between its stop and target, as a 0-100% "zone".
 * Shared by the Portfolio screen (live rendering) and the Watchdog (alerting).
 */
function computeZone(position, currentPrice) {
  const { stopPrice, targetPrice, side } = position;
  if (stopPrice == null || targetPrice == null) return null;

  const isLong = side !== 'short';
  const low = isLong ? stopPrice : targetPrice;
  const high = isLong ? targetPrice : stopPrice;
  const range = high - low;
  if (!range) return null;

  const pct = ((currentPrice - low) / range) * 100;
  const clamped = Math.max(-20, Math.min(120, pct));

  return {
    pctToTarget: +clamped.toFixed(1),
    stopPrice,
    targetPrice,
    breachedStop: isLong ? currentPrice <= stopPrice : currentPrice >= stopPrice,
    hitTarget: isLong ? currentPrice >= targetPrice : currentPrice <= targetPrice,
    nearStop: isLong ? currentPrice > stopPrice && clamped <= 15 : currentPrice < stopPrice && clamped >= 85,
  };
}

module.exports = { sizePosition, checkCorrelations, pearson, dailyReturns, computeZone };
