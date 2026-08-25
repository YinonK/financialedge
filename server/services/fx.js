'use strict';

/**
 * USD/ILS FX via frankfurter.app (free, no key). Note: frankfurter.app
 * redirects to frankfurter.dev/v1 — fetch() follows redirects by default.
 */

let cache = { rate: null, date: null, fetchedAt: 0 };
const CACHE_TTL_MS = 15 * 60 * 1000;

async function getUsdIls() {
  if (cache.rate && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { rate: cache.rate, date: cache.date, cached: true };
  }
  const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=ILS', { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error(`frankfurter.app fetch failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  const rate = json.rates && json.rates.ILS;
  if (!rate) throw new Error('frankfurter.app response missing ILS rate');
  cache = { rate, date: json.date, fetchedAt: Date.now() };
  return { rate, date: json.date, cached: false };
}

function usdToIls(usd, rate) {
  return usd * rate;
}

module.exports = { getUsdIls, usdToIls };
