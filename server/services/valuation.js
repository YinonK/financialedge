'use strict';

/**
 * Valuation stats (P/E, PEG, EV/EBITDA, FCF yield) via Yahoo's unofficial
 * quoteSummary endpoint. Yahoo gates this more aggressively than the chart
 * endpoint and sometimes requires a crumb/cookie, or blocks entirely for a
 * given IP. If it fails, we return a `available: false` object with a
 * manual-check hint — we NEVER fabricate valuation numbers.
 */

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json',
};

const MODULES = 'defaultKeyStatistics,summaryDetail,financialData,price';

async function getValuation(symbol) {
  const encoded = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encoded}?modules=${MODULES}`;

  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (!text || !text.trim()) throw new Error('empty response (likely bot-gated)');
    const json = JSON.parse(text);
    const result = json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
    if (!result) throw new Error('quoteSummary returned no result');

    const stats = result.defaultKeyStatistics || {};
    const summary = result.summaryDetail || {};
    const fin = result.financialData || {};

    const pe = raw(summary.trailingPE) || raw(summary.forwardPE);
    const peg = raw(stats.pegRatio);
    const evEbitda = raw(stats.enterpriseToEbitda);
    const marketCap = raw(stats.marketCap) || raw(summary.marketCap);
    const freeCashflow = raw(fin.freeCashflow);
    const fcfYield = marketCap && freeCashflow ? (freeCashflow / marketCap) * 100 : null;

    return {
      available: true,
      symbol,
      trailingPE: raw(summary.trailingPE),
      forwardPE: raw(summary.forwardPE),
      pegRatio: peg,
      evToEbitda: evEbitda,
      marketCap,
      freeCashflow,
      fcfYieldPct: fcfYield != null ? +fcfYield.toFixed(2) : null,
      profitMarginsPct: raw(fin.profitMargins) != null ? +(raw(fin.profitMargins) * 100).toFixed(2) : null,
      recommendationKey: fin.recommendationKey,
      targetMeanPrice: raw(fin.targetMeanPrice),
    };
  } catch (err) {
    return {
      available: false,
      symbol,
      reason: err.message,
      manualCheckHint: `Yahoo Finance blocked/rate-limited this request. Check ${symbol} manually at finance.yahoo.com/quote/${symbol}/key-statistics or stockanalysis.com/stocks/${symbol}.`,
    };
  }
}

function raw(field) {
  if (field == null) return null;
  if (typeof field === 'object' && 'raw' in field) return field.raw;
  return field;
}

module.exports = { getValuation };
