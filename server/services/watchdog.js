'use strict';

/**
 * Portfolio Watchdog — polls open positions against their stop/target zones
 * and flags anything that needs Yinon's attention. READ-ONLY: this never
 * places, modifies, or cancels an order, and it never touches a stop loss.
 * It only observes and alerts. Yinon decides and executes every action.
 *
 * Designed to be triggered externally (cron-job.org) every 30-60 min during
 * US market hours, the same way the morning briefing wakes a sleeping
 * Render free-tier dyno — see README for the exact cron setup.
 */

const { getQuote } = require('./yahooFinance');
const { computeZone } = require('./riskPortfolio');

/**
 * US equity market hours check (9:30-16:00 America/New_York, Mon-Fri).
 * Does NOT account for market holidays (Yahoo's own market-state flag would
 * be the authoritative source, but isn't reliably present on the chart
 * endpoint) — a stray run on a holiday just does a bit of unnecessary work,
 * it doesn't produce wrong data.
 */
function isUsMarketHours(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);

  const map = {};
  parts.forEach((p) => (map[p.type] = p.value));
  const weekday = map.weekday;
  const hour = parseInt(map.hour, 10);
  const minute = parseInt(map.minute, 10);

  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const minutesSinceMidnight = hour * 60 + minute;
  return minutesSinceMidnight >= 9 * 60 + 30 && minutesSinceMidnight <= 16 * 60;
}

/**
 * Checks every open position's live price against its stop/target zone and
 * returns a list of flags. Each flag is advisory text — nothing here can
 * act on a position.
 */
async function checkPositions(positions) {
  const flags = [];

  const quotes = await Promise.allSettled(positions.map((p) => getQuote(p.ticker)));

  positions.forEach((p, i) => {
    const q = quotes[i];
    if (q.status !== 'fulfilled') {
      flags.push({
        ticker: p.ticker,
        severity: 'info',
        message: `Couldn't get a live quote for ${p.ticker}: ${q.reason ? q.reason.message : 'unknown error'}`,
      });
      return;
    }
    const currentPrice = q.value.price;
    const zone = computeZone(p, currentPrice);
    if (!zone) return; // no stop/target set — nothing to watch

    if (zone.breachedStop) {
      flags.push({
        ticker: p.ticker,
        severity: 'critical',
        message: `${p.ticker} is through your stop (${zone.stopPrice}) — currently ${currentPrice.toFixed(2)}. Your call on what happens next — nothing auto-executes here.`,
      });
    } else if (zone.nearStop) {
      flags.push({
        ticker: p.ticker,
        severity: 'warning',
        message: `${p.ticker} is closing in on your stop (${zone.stopPrice}) — currently ${currentPrice.toFixed(2)}, ${zone.pctToTarget.toFixed(0)}% of the way from stop to target.`,
      });
    }

    if (zone.hitTarget) {
      flags.push({
        ticker: p.ticker,
        severity: 'good',
        message: `${p.ticker} hit your target (${zone.targetPrice}) — currently ${currentPrice.toFixed(2)}. Worth deciding whether to take it, trail it, or let it run.`,
      });
    }
  });

  return flags;
}

module.exports = { checkPositions, isUsMarketHours };
