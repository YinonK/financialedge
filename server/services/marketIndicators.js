'use strict';

const { getSeries, getQuote } = require('./yahooFinance');
const { getFearGreed } = require('./fearGreed');
const { getConsecutiveRedDays } = require('./redDayCounter');

/**
 * Builds the full Market Indicators dashboard payload: one entry per
 * indicator with { id, label, category('user'|'brain'), status('red'|'watch'|'green'|'na'),
 * value, threshold, explanation, howToRead, whyItMatters, historicalExample }.
 *
 * Indicators with no free live feed (S5FI, Put/Call, AAII bears, A/D
 * divergence) are always returned as status:'na' with manual-check
 * instructions — never estimated or faked.
 */

const EXPLAINERS = {
  fearGreed: {
    explanation:
      'CNN\'s Fear & Greed Index blends 7 market signals (momentum, breadth, put/call, junk bond spreads, volatility, safe-haven demand, stock strength) into one 0-100 score.',
    howToRead: '0-24 Extreme Fear, 25-44 Fear, 45-55 Neutral, 56-75 Greed, 76-100 Extreme Greed. Extreme fear often marks tradeable bottoms; extreme greed often precedes pullbacks.',
    whyItMatters: 'Yinon uses this as a contrarian bottom-fishing signal — extreme fear (<15) is when bold, high-conviction entries have historically offered the best risk/reward.',
    historicalExample: 'Score bottomed near 12 in March 2020 and again near 20 in the Oct 2022 low — both preceded multi-month rallies.',
  },
  vix: {
    explanation: 'The CBOE Volatility Index (VIX) measures the market\'s expected 30-day volatility, derived from S&P 500 options prices.',
    howToRead: 'Under 15: complacency. 15-20: normal. 20-30: elevated fear (watch zone). Above 30: panic/crisis-level fear.',
    whyItMatters: 'Spikes above 30 have historically coincided with capitulation-style selling — often good hunting ground for bold entries with tight risk control.',
    historicalExample: 'VIX spiked to 82 in March 2020 and to 38 in August 2024\'s carry-trade unwind — both were short-lived extremes.',
  },
  redDays: {
    explanation: 'Consecutive daily closes lower than the prior close for the S&P 500, counted server-side from raw closing prices.',
    howToRead: '3+ consecutive red days is unusual and often signals either the start of a real drawdown or a near-term exhaustion/bounce setup.',
    whyItMatters: 'Strings of red days often cluster right before volatility (and opportunity) spikes — worth cross-checking against Fear & Greed and VIX.',
    historicalExample: 'Sept 2024\'s 3-day slide preceded a sharp two-week bounce.',
  },
  us10y: {
    explanation: 'The 10-Year US Treasury yield — the benchmark "risk-free" rate that anchors equity valuations and discount rates.',
    howToRead: 'Rising yields pressure high-multiple growth stocks (higher discount rate on future cash flows); above 4.5% has recently been a pain threshold for equities.',
    whyItMatters: 'Fast, sharp moves above 4.5% have repeatedly triggered growth-stock drawdowns since 2022 — a macro headwind check before sizing up risk.',
    historicalExample: '10Y crossing 5% in Oct 2023 coincided with a sharp equity selloff into the October low.',
  },
  putCall: {
    explanation: 'The CBOE equity put/call ratio — how many puts are being bought for every call.',
    howToRead: 'Above 1.0 means more puts than calls (defensive/bearish positioning); above 1.2 is unusually stretched and often contrarian-bullish.',
    whyItMatters: 'Extreme put buying often marks capitulation in options positioning, a classic contrarian tell The Brain weighs alongside Fear & Greed.',
    historicalExample: 'Put/call spiked above 1.3 during the Dec 2018 selloff, just before a sharp Q1 2019 recovery.',
  },
  dxy: {
    explanation: 'The US Dollar Index (DXY) tracks the dollar against a basket of major currencies.',
    howToRead: 'A strong, fast-rising dollar (above 105) tightens global financial conditions and pressures multinational earnings and commodities.',
    whyItMatters: 'Dollar spikes have historically coincided with EM stress and risk-off moves in US equities, especially exporters.',
    historicalExample: 'DXY\'s run above 114 in Sept-Oct 2022 lined up with the S&P 500\'s cycle low.',
  },
  adDivergence: {
    explanation: 'Advance/Decline divergence: when the index makes new highs but the number of advancing stocks (breadth) fails to confirm.',
    howToRead: 'Narrowing breadth (fewer stocks participating) while the index grinds higher is a classic late-cycle warning sign.',
    whyItMatters: 'Breadth divergences have historically preceded several sharp corrections by weeks to months.',
    historicalExample: 'Breadth diverged badly into the Jan 2022 top before the year\'s bear market.',
  },
  aaiiBears: {
    explanation: 'The AAII Investor Sentiment Survey % of individual investors describing themselves as "bearish" over the next 6 months.',
    howToRead: 'Above 50% bearish is historically rare and has often marked sentiment-driven bottoms (contrarian signal).',
    whyItMatters: 'Extreme retail bearishness has a decent track record as a contrarian bullish tell when paired with other confirming signals.',
    historicalExample: 'Bears hit 59% in Sept 2022, within weeks of the cycle low.',
  },
  s5fi: {
    explanation: 'S5FI-style short-term breadth/financial-conditions style composite (tracked manually — no reliable free real-time feed).',
    howToRead: 'Below 20 flagged by Yinon as his own stress threshold.',
    whyItMatters: 'Personal threshold Yinon watches manually alongside the automated feeds above.',
    historicalExample: 'N/A — manual tracking only.',
  },
  gold: {
    explanation: 'Gold futures (GC=F) — the classic safe-haven / inflation-hedge asset.',
    howToRead: 'A sharp single-day spike (>2%) or breakout above recent highs signals a flight to safety or inflation concern building.',
    whyItMatters: 'Gold spikes often coincide with, or slightly lead, broader risk-off moves in equities.',
    historicalExample: 'Gold spiked through $2,400 in early 2024 as rate-cut bets and geopolitical stress built simultaneously.',
  },
  wti: {
    explanation: 'WTI crude oil futures (CL=F) — a proxy for growth demand and geopolitical/supply shocks.',
    howToRead: 'Sharp moves (>3% in a day) often reflect geopolitical shocks (supply-side) or demand-growth scares — both matter for the macro backdrop.',
    whyItMatters: 'Oil shocks feed directly into inflation expectations and consumer spending power, both inputs to the macro & geopolitics lens.',
    historicalExample: 'WTI\'s spike above $130 after the Feb 2022 invasion of Ukraine fed straight into that year\'s inflation scare.',
  },
};

function status(value, redFn, watchFn) {
  if (value == null) return 'na';
  if (redFn(value)) return 'red';
  if (watchFn && watchFn(value)) return 'watch';
  return 'green';
}

async function getIndicators(thresholds) {
  const t = thresholds || {
    user: { fearGreedBelow: 15, vixAbove: 30, vixWatchAbove: 20, s5fiBelow: 20, consecutiveRedDays: 3 },
    brain: { us10yAbove: 4.5, putCallAbove: 1.2, dxyAbove: 105, aaiiBearsAbove: 50 },
  };

  const results = [];

  // ---- USER (blue) indicators ----
  const settled = await Promise.allSettled([
    getFearGreed(),
    getQuote('^VIX'),
    getConsecutiveRedDays(),
    getQuote('^TNX'),
    getQuote('DX-Y.NYB'),
    getSeries('GC=F', { range: '5d', interval: '1d' }),
    getSeries('CL=F', { range: '5d', interval: '1d' }),
  ]);

  const [fgRes, vixRes, redRes, tnxRes, dxyRes, goldRes, wtiRes] = settled;

  results.push(buildIndicator('fearGreed', 'Fear & Greed Index', 'user', fgRes, (r) => r.score, (v) =>
    status(v, (x) => x < t.user.fearGreedBelow, null)
  ));

  results.push(
    buildIndicator('vix', 'VIX', 'user', vixRes, (r) => r.price, (v) =>
      status(v, (x) => x > t.user.vixAbove, (x) => x > t.user.vixWatchAbove)
    )
  );

  results.push(
    buildIndicator('redDays', 'Consecutive Red Days (S&P 500)', 'user', redRes, (r) => r.consecutiveRedDays, (v) =>
      status(v, (x) => x >= t.user.consecutiveRedDays, null)
    )
  );

  results.push(naIndicator('s5fi', 'S5FI', 'user', 'No free real-time feed exists for this composite. Check your usual source manually and log it in Signals if it crosses 20.'));

  // ---- BRAIN (gold) indicators ----
  results.push(
    buildIndicator('us10y', 'US 10-Year Treasury Yield', 'brain', tnxRes, (r) => r.price, (v) =>
      status(v, (x) => x > t.brain.us10yAbove, null)
    )
  );

  results.push(naIndicator('putCall', 'CBOE Put/Call Ratio', 'brain', 'No free real-time feed. Check cboe.com/us/options/market_statistics/daily/ and log manually if it prints above 1.2.'));

  results.push(
    buildIndicator('dxy', 'US Dollar Index (DXY)', 'brain', dxyRes, (r) => r.price, (v) =>
      status(v, (x) => x > t.brain.dxyAbove, null)
    )
  );

  results.push(naIndicator('adDivergence', 'Advance/Decline Divergence', 'brain', 'No free real-time breadth feed. Check the NYSE A/D line at stockcharts.com ($NYAD) against the S&P 500 chart manually.'));

  results.push(naIndicator('aaiiBears', 'AAII Bears %', 'brain', 'AAII publishes this weekly (Thursdays) at aaii.com/sentimentsurvey — no free API. Log manually if bears print above 50%.'));

  results.push(buildSpikeIndicator('gold', 'Gold (GC=F)', 'brain', goldRes));
  results.push(buildSpikeIndicator('wti', 'WTI Crude (CL=F)', 'brain', wtiRes));

  const redCount = results.filter((r) => r.status === 'red').length;
  const watchCount = results.filter((r) => r.status === 'watch').length;

  return {
    indicators: results,
    redCount,
    watchCount,
    confluenceAlert: redCount >= 2,
    asOf: new Date().toISOString(),
  };
}

function buildIndicator(id, label, category, settledResult, valueFn, statusFn) {
  const meta = EXPLAINERS[id] || {};
  if (settledResult.status !== 'fulfilled') {
    return {
      id,
      label,
      category,
      status: 'na',
      value: null,
      error: settledResult.reason ? settledResult.reason.message : 'fetch failed',
      manualCheckHint: `Live feed failed — check ${label} manually for now.`,
      ...meta,
    };
  }
  const value = valueFn(settledResult.value);
  return {
    id,
    label,
    category,
    status: statusFn(value),
    value,
    ...meta,
  };
}

function naIndicator(id, label, category, manualCheckHint) {
  const meta = EXPLAINERS[id] || {};
  return { id, label, category, status: 'na', value: null, manualCheckHint, ...meta };
}

function buildSpikeIndicator(id, label, category, settledResult) {
  const meta = EXPLAINERS[id] || {};
  if (settledResult.status !== 'fulfilled') {
    return {
      id,
      label,
      category,
      status: 'na',
      value: null,
      error: settledResult.reason ? settledResult.reason.message : 'fetch failed',
      manualCheckHint: `Live feed failed — check ${label} manually for now.`,
      ...meta,
    };
  }
  const series = settledResult.value;
  const closes = series.close;
  const n = closes.length;
  if (n < 2) return { id, label, category, status: 'na', value: null, ...meta };
  const changePct = ((closes[n - 1] - closes[n - 2]) / closes[n - 2]) * 100;
  const isSpike = Math.abs(changePct) > (id === 'wti' ? 3 : 2);
  return {
    id,
    label,
    category,
    status: isSpike ? 'red' : 'green',
    value: +changePct.toFixed(2),
    lastPrice: closes[n - 1],
    ...meta,
  };
}

module.exports = { getIndicators };
