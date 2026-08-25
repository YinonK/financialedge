'use strict';

/**
 * CNN Fear & Greed Index — unofficial dataviz endpoint.
 * https://production.dataviz.cnn.io/index/fearandgreed/graphdata
 */

const URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json',
};

async function getFearGreed() {
  const res = await fetch(URL, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error(`CNN Fear & Greed fetch failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  const fng = json.fear_and_greed;
  if (!fng) {
    throw new Error('CNN Fear & Greed response missing fear_and_greed field');
  }
  return {
    score: fng.score != null ? Math.round(fng.score) : null,
    rating: fng.rating,
    previousClose: fng.previous_close,
    previousWeek: fng.previous_1_week,
    previousMonth: fng.previous_1_month,
    previousYear: fng.previous_1_year,
    asOf: fng.timestamp,
  };
}

module.exports = { getFearGreed };
