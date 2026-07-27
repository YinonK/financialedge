'use strict';

const { getSeries } = require('./yahooFinance');

/**
 * Computes the number of consecutive red (down) closing days for the S&P 500,
 * counting backward from the most recent close. Server-side derived — never
 * relies on a third-party "red streak" number that could go stale/be faked.
 */
async function getConsecutiveRedDays() {
  const series = await getSeries('^GSPC', { range: '1mo', interval: '1d' });
  const closes = series.close;
  let count = 0;
  for (let i = closes.length - 1; i > 0; i--) {
    if (closes[i] < closes[i - 1]) {
      count++;
    } else {
      break;
    }
  }
  return {
    consecutiveRedDays: count,
    lastClose: closes[closes.length - 1],
    asOf: series.timestamps[series.timestamps.length - 1],
  };
}

module.exports = { getConsecutiveRedDays };
