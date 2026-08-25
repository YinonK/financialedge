'use strict';

/**
 * Flow & sentiment data (analyst revisions, short interest, insider activity)
 * via Yahoo's quoteSummary. Same bot-gating caveats as valuation.js apply —
 * on failure we return available:false with a manual-check hint, never a
 * fabricated number.
 */

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json',
};

const MODULES = 'recommendationTrend,defaultKeyStatistics,netSharePurchaseActivity,insiderTransactions';

async function getFlowSentiment(symbol) {
  const encoded = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encoded}?modules=${MODULES}`;

  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (!text || !text.trim()) throw new Error('empty response (likely bot-gated)');
    const json = JSON.parse(text);
    const result = json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
    if (!result) throw new Error('quoteSummary returned no result');

    const trend = result.recommendationTrend && result.recommendationTrend.trend;
    const latestTrend = trend && trend[0];
    const stats = result.defaultKeyStatistics || {};
    const netPurchase = result.netSharePurchaseActivity || {};
    const insiderTx = (result.insiderTransactions && result.insiderTransactions.transactions) || [];

    return {
      available: true,
      symbol,
      analystTrend: latestTrend
        ? {
            period: latestTrend.period,
            strongBuy: latestTrend.strongBuy,
            buy: latestTrend.buy,
            hold: latestTrend.hold,
            sell: latestTrend.sell,
            strongSell: latestTrend.strongSell,
          }
        : null,
      shortInterest: {
        sharesShort: raw(stats.sharesShort),
        shortRatio: raw(stats.shortRatio),
        shortPercentOfFloat: raw(stats.shortPercentOfFloat) != null ? +(raw(stats.shortPercentOfFloat) * 100).toFixed(2) : null,
        sharesShortPriorMonth: raw(stats.sharesShortPriorMonth),
      },
      insiders: {
        netPercentInsiderShares:
          raw(netPurchase.netPercentInsiderShares) != null ? +(raw(netPurchase.netPercentInsiderShares) * 100).toFixed(2) : null,
        buyInfoCount: raw(netPurchase.buyInfoCount),
        sellInfoCount: raw(netPurchase.sellInfoCount),
        recentTransactionCount: insiderTx.length,
      },
    };
  } catch (err) {
    return {
      available: false,
      symbol,
      reason: err.message,
      manualCheckHint: `Check analyst revisions / short interest / insider activity manually at finance.yahoo.com/quote/${symbol}/analysis and finance.yahoo.com/quote/${symbol}/insider-transactions.`,
    };
  }
}

function raw(field) {
  if (field == null) return null;
  if (typeof field === 'object' && 'raw' in field) return field.raw;
  return field;
}

module.exports = { getFlowSentiment };
