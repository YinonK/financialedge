'use strict';

/**
 * Yahoo Finance (unofficial) chart API client.
 *
 * Yahoo has tightened bot protection over time. Some deployments need a
 * "crumb" + cookie pair before /v8/finance/chart will return data; others
 * work with a plain browser-like User-Agent. This client tries the plain
 * request first, and if Yahoo comes back empty/blocked, fetches a crumb
 * and retries once. If both fail, it throws — callers must surface this as
 * "data unavailable", never fabricate numbers.
 */

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
};

const CHART_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

let cachedCookie = null;
let cachedCrumb = null;
let crumbFetchedAt = 0;
const CRUMB_TTL_MS = 30 * 60 * 1000;

async function fetchCrumb() {
  if (cachedCrumb && Date.now() - crumbFetchedAt < CRUMB_TTL_MS) {
    return { crumb: cachedCrumb, cookie: cachedCookie };
  }
  const res = await fetch('https://fc.yahoo.com', { headers: BROWSER_HEADERS });
  const setCookie = res.headers.get('set-cookie');
  const cookie = setCookie ? setCookie.split(';')[0] : null;

  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { ...BROWSER_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
  });
  const crumb = await crumbRes.text();
  cachedCookie = cookie;
  cachedCrumb = crumb && crumb.length < 50 ? crumb : null;
  crumbFetchedAt = Date.now();
  return { crumb: cachedCrumb, cookie: cachedCookie };
}

async function fetchChartRaw(symbol, { range = '1y', interval = '1d' } = {}) {
  const encoded = encodeURIComponent(symbol);
  let lastErr = null;

  for (const host of CHART_HOSTS) {
    const url = `https://${host}/v8/finance/chart/${encoded}?range=${range}&interval=${interval}`;
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      const text = await res.text();
      if (text && text.trim().length > 0) {
        const json = JSON.parse(text);
        if (json && json.chart && json.chart.result && json.chart.result.length) {
          return json;
        }
      }
      lastErr = new Error(`Empty/blocked response from ${host} (status ${res.status})`);
    } catch (err) {
      lastErr = err;
    }
  }

  // Retry once with crumb+cookie in case Yahoo is gating on that.
  try {
    const { crumb, cookie } = await fetchCrumb();
    if (crumb) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=${range}&interval=${interval}&crumb=${encodeURIComponent(
        crumb
      )}`;
      const res = await fetch(url, {
        headers: { ...BROWSER_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
      });
      const text = await res.text();
      if (text && text.trim().length > 0) {
        const json = JSON.parse(text);
        if (json && json.chart && json.chart.result && json.chart.result.length) {
          return json;
        }
      }
    }
  } catch (err) {
    lastErr = err;
  }

  throw new Error(
    `Yahoo Finance chart fetch failed for "${symbol}": ${lastErr ? lastErr.message : 'unknown error'}`
  );
}

/**
 * Returns a clean series: { symbol, currency, timestamps[], close[], high[], low[], volume[], meta }
 */
async function getSeries(symbol, opts = {}) {
  const json = await fetchChartRaw(symbol, opts);
  const result = json.chart.result[0];
  const timestamps = result.timestamp || [];
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};

  const close = quote.close || [];
  const high = quote.high || [];
  const low = quote.low || [];
  const volume = quote.volume || [];

  // filter out nulls (holidays/half-days sometimes leave gaps)
  const clean = { timestamps: [], close: [], high: [], low: [], volume: [] };
  for (let i = 0; i < timestamps.length; i++) {
    if (close[i] == null) continue;
    clean.timestamps.push(timestamps[i]);
    clean.close.push(close[i]);
    clean.high.push(high[i] != null ? high[i] : close[i]);
    clean.low.push(low[i] != null ? low[i] : close[i]);
    clean.volume.push(volume[i] != null ? volume[i] : 0);
  }

  return {
    symbol,
    currency: result.meta.currency,
    exchangeName: result.meta.exchangeName,
    regularMarketPrice: result.meta.regularMarketPrice,
    previousClose: result.meta.chartPreviousClose || result.meta.previousClose,
    ...clean,
  };
}

async function getQuote(symbol) {
  // Lightweight: last 5 days, derive latest price + 1-day change.
  const series = await getSeries(symbol, { range: '5d', interval: '1d' });
  const n = series.close.length;
  const last = series.regularMarketPrice != null ? series.regularMarketPrice : series.close[n - 1];
  const prevClose = series.previousClose != null ? series.previousClose : series.close[n - 2];
  const change = last - prevClose;
  const changePct = prevClose ? (change / prevClose) * 100 : null;
  return {
    symbol,
    price: last,
    previousClose: prevClose,
    change,
    changePct,
    currency: series.currency,
    asOf: series.timestamps[n - 1],
  };
}

// ---- Technical indicators (computed from a close-price series) ----

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function rsiSeries(values, period = 14) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    out[i] = rsi(values.slice(0, i + 1), period);
  }
  return out;
}

function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => (emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null));
  const macdValues = macdLine.filter((v) => v != null);
  const signalRaw = ema(macdValues, signalPeriod);
  // align signal back to full-length array
  const signalLine = new Array(values.length).fill(null);
  let offset = macdLine.findIndex((v) => v != null);
  for (let i = 0; i < signalRaw.length; i++) {
    if (signalRaw[i] != null) signalLine[offset + i] = signalRaw[i];
  }
  const histogram = values.map((_, i) =>
    macdLine[i] != null && signalLine[i] != null ? macdLine[i] - signalLine[i] : null
  );
  return { macdLine, signalLine, histogram };
}

function detectDivergence(closes, rsiVals, lookback = 20) {
  // Simple divergence heuristic: compare the two most recent swing points
  // in price vs RSI over the lookback window.
  const n = closes.length;
  if (n < lookback + 2) return { bullish: false, bearish: false, note: 'insufficient data' };
  const window = closes.slice(n - lookback);
  const rsiWindow = rsiVals.slice(n - lookback);

  let maxIdx = 0;
  let minIdx = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i] > window[maxIdx]) maxIdx = i;
    if (window[i] < window[minIdx]) minIdx = i;
  }

  const priceStart = window[0];
  const priceEnd = window[window.length - 1];
  const rsiStart = rsiWindow[0];
  const rsiEnd = rsiWindow[rsiWindow.length - 1];

  const bearish = priceEnd >= priceStart && rsiEnd < rsiStart && rsiEnd != null && rsiStart != null;
  const bullish = priceEnd <= priceStart && rsiEnd > rsiStart && rsiEnd != null && rsiStart != null;

  return {
    bullish,
    bearish,
    note: bullish
      ? 'Price making lower/flat lows while RSI rises — potential bullish divergence.'
      : bearish
      ? 'Price making higher/flat highs while RSI falls — potential bearish divergence.'
      : 'No clear divergence over the lookback window.',
  };
}

function fibonacciLevels(high, low, direction = 'retracement') {
  const diff = high - low;
  const retracementRatios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const extensionRatios = [1.272, 1.414, 1.618, 2, 2.618];

  const retracements = {};
  retracementRatios.forEach((r) => {
    retracements[r] = +(high - diff * r).toFixed(2);
  });

  const extensions = {};
  extensionRatios.forEach((r) => {
    extensions[r] = +(high + diff * (r - 1)).toFixed(2);
  });

  return { high, low, retracements, extensions };
}

function swingHighLow(highs, lows, lookback = 60) {
  const h = highs.slice(-lookback);
  const l = lows.slice(-lookback);
  return { high: Math.max(...h), low: Math.min(...l) };
}

/**
 * Full technical read for a symbol: DMA 50/200, RSI, MACD (+divergence), volume trend, Fib levels.
 */
async function getTechnicals(symbol) {
  const series = await getSeries(symbol, { range: '2y', interval: '1d' });
  const closes = series.close;
  const n = closes.length;

  const dma50 = sma(closes, 50);
  const dma200 = sma(closes, 200);
  const dma50Series = smaSeries(closes, 50);
  const dma200Series = smaSeries(closes, 200);

  // golden/death cross check over the last 10 sessions
  let crossSignal = 'none';
  for (let i = Math.max(1, n - 10); i < n; i++) {
    if (dma50Series[i] == null || dma200Series[i] == null) continue;
    if (dma50Series[i] > dma200Series[i] && dma50Series[i - 1] <= dma200Series[i - 1]) crossSignal = 'golden_cross';
    if (dma50Series[i] < dma200Series[i] && dma50Series[i - 1] >= dma200Series[i - 1]) crossSignal = 'death_cross';
  }

  const rsiVal = rsi(closes, 14);
  const rsiVals = rsiSeries(closes, 14);
  const macdResult = macd(closes);
  const divergence = detectDivergence(closes, rsiVals);

  const swing = swingHighLow(series.high, series.low, 90);
  const fib = fibonacciLevels(swing.high, swing.low);

  const recentVol = series.volume.slice(-10);
  const priorVol = series.volume.slice(-30, -10);
  const avgRecentVol = recentVol.reduce((a, b) => a + b, 0) / (recentVol.length || 1);
  const avgPriorVol = priorVol.reduce((a, b) => a + b, 0) / (priorVol.length || 1);
  const volumeTrend = avgPriorVol ? ((avgRecentVol - avgPriorVol) / avgPriorVol) * 100 : null;

  return {
    symbol,
    lastClose: closes[n - 1],
    dma50,
    dma200,
    trendVsDma: dma50 && dma200 ? (dma50 > dma200 ? 'bullish_structure' : 'bearish_structure') : null,
    crossSignal,
    rsi14: rsiVal != null ? +rsiVal.toFixed(1) : null,
    macd: {
      line: macdResult.macdLine[n - 1],
      signal: macdResult.signalLine[n - 1],
      histogram: macdResult.histogram[n - 1],
    },
    divergence,
    volume: {
      last: series.volume[n - 1],
      avgRecent10d: Math.round(avgRecentVol),
      avgPrior10to30d: Math.round(avgPriorVol),
      trendPct: volumeTrend != null ? +volumeTrend.toFixed(1) : null,
    },
    fibonacci: fib,
  };
}

module.exports = {
  getSeries,
  getQuote,
  getTechnicals,
  // exported for testing / reuse
  sma,
  ema,
  rsi,
  macd,
  fibonacciLevels,
};
