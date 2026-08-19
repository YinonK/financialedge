'use strict';

/**
 * Daily Opportunity Hunt — the Brain goes looking, instead of only reacting.
 *
 * Candidate universe, in priority order:
 *   1. Tickers appearing in recently ingested channel signals that Yinon
 *      does NOT already hold (his channels are the highest-signal source
 *      he has, and they're already flowing in).
 *   2. Yahoo's trending tickers — best-effort only. It's an undocumented
 *      endpoint; if it fails the hunt continues on signal flow alone rather
 *      than failing the whole run.
 *
 * Candidates are then screened on real technicals (server-computed, not
 * guessed), ranked, and the top few go to the Council for a brainstorm.
 *
 * Bounded on purpose: Render's free tier and cron-job.org's 30s timeout mean
 * an unbounded scan would just die. Better a reliable look at 3 names than a
 * timeout on 30.
 *
 * READ-ONLY: this proposes things to look at. It never trades.
 */

const { getTechnicals } = require('./yahooFinance');

const MAX_CANDIDATES_SCREENED = 8;
const MAX_CANDIDATES_TO_COUNCIL = 3;
const SIGNAL_LOOKBACK_DAYS = 7;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json',
};

async function getTrendingTickers() {
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v1/finance/trending/US?count=15', {
      headers: BROWSER_HEADERS,
    });
    const text = await res.text();
    if (!text || !text.trim()) return [];
    const json = JSON.parse(text);
    const quotes =
      json.finance && json.finance.result && json.finance.result[0] && json.finance.result[0].quotes;
    if (!Array.isArray(quotes)) return [];
    return quotes.map((q) => q.symbol).filter(Boolean);
  } catch (err) {
    console.error('[opportunityHunt] trending fetch failed (continuing on signals only):', err.message);
    return [];
  }
}

function tickersFromRecentSignals(signals) {
  const cutoff = Date.now() - SIGNAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const counts = new Map();
  for (const s of signals) {
    if (new Date(s.pastedAt).getTime() < cutoff) continue;
    for (const t of s.tickers || []) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ticker, mentions]) => ({ ticker, mentions }));
}

/**
 * Fast technical screen. Ranks on structure + momentum rather than trying to
 * be clever: names in a bullish structure, not already extended, with volume
 * showing up. Anything Yahoo won't return data for is dropped, never guessed.
 */
function scoreCandidate(tech, mentions) {
  let score = 0;
  const reasons = [];

  if (tech.trendVsDma === 'bullish_structure') {
    score += 2;
    reasons.push('50 DMA above 200 DMA');
  }
  if (tech.crossSignal === 'golden_cross') {
    score += 3;
    reasons.push('recent golden cross');
  }
  if (tech.crossSignal === 'death_cross') {
    score -= 3;
    reasons.push('recent death cross');
  }
  if (tech.rsi14 != null) {
    if (tech.rsi14 >= 40 && tech.rsi14 <= 65) {
      score += 2;
      reasons.push(`RSI ${tech.rsi14} — room to run`);
    } else if (tech.rsi14 > 75) {
      score -= 2;
      reasons.push(`RSI ${tech.rsi14} — extended`);
    } else if (tech.rsi14 < 30) {
      score += 1;
      reasons.push(`RSI ${tech.rsi14} — oversold`);
    }
  }
  if (tech.macd && tech.macd.histogram != null && tech.macd.histogram > 0) {
    score += 1;
    reasons.push('MACD histogram positive');
  }
  if (tech.divergence && tech.divergence.bullish) {
    score += 2;
    reasons.push('bullish RSI divergence');
  }
  if (tech.divergence && tech.divergence.bearish) {
    score -= 2;
    reasons.push('bearish RSI divergence');
  }
  if (tech.volume && tech.volume.trendPct != null && tech.volume.trendPct > 20) {
    score += 1;
    reasons.push(`volume +${tech.volume.trendPct}% vs prior weeks`);
  }
  if (mentions > 1) {
    score += Math.min(mentions, 3);
    reasons.push(`${mentions} channel mentions this week`);
  }

  return { score, reasons };
}

/**
 * Builds and screens the candidate list. Returns ranked candidates with the
 * real technical data behind each one.
 */
async function huntCandidates(context) {
  const held = new Set((context.portfolio.positions || []).map((p) => p.ticker));

  const signalCandidates = tickersFromRecentSignals(context.signals.items || []);
  const trending = await getTrendingTickers();

  const pool = new Map();
  for (const { ticker, mentions } of signalCandidates) {
    if (held.has(ticker)) continue;
    pool.set(ticker, { ticker, mentions, origin: 'channel signals' });
  }
  for (const ticker of trending) {
    if (held.has(ticker) || pool.has(ticker)) continue;
    pool.set(ticker, { ticker, mentions: 0, origin: 'Yahoo trending' });
  }

  const shortlist = [...pool.values()].slice(0, MAX_CANDIDATES_SCREENED);
  if (!shortlist.length) {
    return { candidates: [], screened: 0, note: 'No candidates outside the current book this week.' };
  }

  const techResults = await Promise.allSettled(shortlist.map((c) => getTechnicals(c.ticker)));

  const scored = [];
  shortlist.forEach((c, i) => {
    const r = techResults[i];
    if (r.status !== 'fulfilled') return; // no data = not a candidate, never a guess
    const tech = r.value;
    const { score, reasons } = scoreCandidate(tech, c.mentions);
    scored.push({
      ticker: c.ticker,
      origin: c.origin,
      mentions: c.mentions,
      score,
      reasons,
      technicals: {
        lastClose: tech.lastClose,
        dma50: tech.dma50,
        dma200: tech.dma200,
        trendVsDma: tech.trendVsDma,
        crossSignal: tech.crossSignal,
        rsi14: tech.rsi14,
        macdHistogram: tech.macd ? tech.macd.histogram : null,
        volumeTrendPct: tech.volume ? tech.volume.trendPct : null,
        fibonacci: tech.fibonacci,
      },
    });
  });

  scored.sort((a, b) => b.score - a.score);

  return {
    candidates: scored.slice(0, MAX_CANDIDATES_TO_COUNCIL),
    allScored: scored,
    screened: shortlist.length,
    dataFailures: shortlist.length - scored.length,
  };
}

module.exports = { huntCandidates, scoreCandidate, tickersFromRecentSignals };
