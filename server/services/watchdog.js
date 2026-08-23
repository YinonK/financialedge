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

const { getQuote, getTechnicals } = require('./yahooFinance');
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

/**
 * Detects material events for HELD positions — the trigger for an immediate
 * Portfolio Council Review rather than waiting for the next scheduled sweep.
 *
 * Two detectors today:
 *   1. A newly-ingested signal mentions a ticker we hold. The channels are
 *      Yinon's highest-signal source; if they start talking about something
 *      in the book, that's worth re-underwriting now.
 *   2. Price breaks a structural level (200 DMA, or a Fibonacci retracement
 *      level), in either direction — a level break is exactly the kind of
 *      thesis-relevant change that never trips a stop.
 *
 * Signal-driven events are deduped per position via seenSignalIds, so one
 * post doesn't re-fire a review on every watchdog tick.
 */
async function detectMaterialEvents(context, positions) {
  const events = [];
  const seen = (context.positionReviews && context.positionReviews.seenSignalIds) || {};
  const recentCutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;

  for (const position of positions) {
    // --- 1. New signal chatter about a name we hold ---
    const fresh = (context.signals.items || []).filter(
      (s) =>
        (s.tickers || []).includes(position.ticker) &&
        new Date(s.pastedAt).getTime() >= recentCutoff &&
        !(seen[position.id] || []).includes(s.id)
    );
    if (fresh.length) {
      events.push({
        positionId: position.id,
        ticker: position.ticker,
        type: 'new_signal',
        reason: `${fresh.length} new signal${fresh.length === 1 ? '' : 's'} mentioning ${position.ticker} arrived from your channels (source${
          fresh.length === 1 ? '' : 's'
        }: ${[...new Set(fresh.map((s) => s.source))].join(', ')})`,
        signalIds: fresh.map((s) => s.id),
      });
      continue; // one event per position per tick is enough to trigger a review
    }

    // --- 2. Structural level break ---
    try {
      const tech = await getTechnicals(position.ticker);
      const price = tech.lastClose;
      const levels = [];
      if (tech.dma200 != null) levels.push({ name: '200 DMA', value: tech.dma200 });
      if (tech.fibonacci && tech.fibonacci.retracements) {
        const fib = tech.fibonacci.retracements;
        if (fib['0.618'] != null) levels.push({ name: '0.618 Fib', value: fib['0.618'] });
        if (fib['0.5'] != null) levels.push({ name: '0.5 Fib', value: fib['0.5'] });
      }

      // "Just broke" = within 1.5% of the level, so we catch the break rather
      // than reporting a level crossed weeks ago.
      const broken = levels.find((l) => {
        const distPct = Math.abs((price - l.value) / l.value) * 100;
        return distPct <= 1.5;
      });

      if (broken) {
        events.push({
          positionId: position.id,
          ticker: position.ticker,
          type: 'level_break',
          reason: `${position.ticker} is testing/breaking its ${broken.name} (${broken.value.toFixed(2)}) at ${price.toFixed(
            2
          )}`,
        });
      }
    } catch (err) {
      // No data is not an event. Stay quiet rather than guessing.
    }
  }

  return events;
}

module.exports = { checkPositions, isUsMarketHours, detectMaterialEvents };
