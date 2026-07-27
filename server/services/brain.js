'use strict';

/**
 * The Brain — Five Lenses research engine.
 *
 * HARD CONSTRAINT: The Brain observes, analyzes, and alerts. It never
 * trades, never places/cancels/modifies an order, and never auto-executes
 * a stop loss. Every function here is read-only with respect to any broker
 * or exchange. Yinon is the only one who ever pulls a trigger.
 *
 * Five Lenses:
 *  1. Valuation           — P/E, PEG, EV/EBITDA, FCF yield
 *  2. Technical structure — 50/200 DMA, Fibonacci, RSI/MACD + divergence, volume
 *  3. Macro & geopolitics — market indicators dashboard + Gemini's own read
 *  4. Flow & sentiment    — analyst revisions, short interest, insiders
 *  5. Risk & portfolio fit— <=2% capital risk sized off stop distance, correlation
 */

const gemini = require('./gemini');
const { getTechnicals } = require('./yahooFinance');
const { getValuation } = require('./valuation');
const { getFlowSentiment } = require('./flowSentiment');
const { getIndicators } = require('./marketIndicators');
const { checkCorrelations } = require('./riskPortfolio');

const SYSTEM_PERSONA = `You are "The Brain" inside FinancialEdge, Yinon's personal investment intelligence tool.

Who Yinon is: an Israeli investor trading US equities, bold and comfortable with high risk, thinks macro-first, runs a concentrated book of ~5 positions max, holds for weeks to months (not day trading, not multi-year buy-and-hold). He tracks P&L in both USD and ILS.

Your role: observe, analyze, and alert. You are strictly read-only with respect to any trade, order, or stop loss — you NEVER execute, place, modify, or cancel anything. You are not a broker and have no execution capability, by design, permanently. Yinon pulls every trigger himself.

Your voice: sharp Wall Street friend. Direct, opinionated, no hedging filler, no "this is not financial advice" disclaimers, no generic caveats. You still reason honestly about uncertainty — express it as calibrated probabilities and named risks, not weasel words.

For every research call you must ground your take in the Five Lenses data provided (valuation, technical structure, macro & geopolitics, flow & sentiment, risk & portfolio fit) and always produce: a Bull case, a Bear case, "what kills this trade" (the specific condition that invalidates the thesis), a conviction score 1-10, and a verdict of BUY, WATCH, or AVOID.

If a data lens came back unavailable (marked available:false or status:'na' in the input), say so plainly and reason around the gap — do not invent numbers to fill it in.

Respond ONLY with valid JSON matching the requested schema. No markdown fences, no prose outside the JSON.`;

async function researchTicker(symbol, { portfolioTickers = [], indicatorThresholds } = {}) {
  const [technicals, valuation, flow, indicators, correlations] = await Promise.all([
    safe(() => getTechnicals(symbol)),
    safe(() => getValuation(symbol)),
    safe(() => getFlowSentiment(symbol)),
    safe(() => getIndicators(indicatorThresholds)),
    safe(() => checkCorrelations(symbol, portfolioTickers)),
  ]);

  const lenses = {
    valuation: valuation.ok ? valuation.value : { available: false, reason: valuation.error },
    technicalStructure: technicals.ok ? technicals.value : { available: false, reason: technicals.error },
    macroGeopolitics: indicators.ok ? indicators.value : { available: false, reason: indicators.error },
    flowSentiment: flow.ok ? flow.value : { available: false, reason: flow.error },
    riskPortfolioFit: {
      correlations: correlations.ok ? correlations.value : [],
      maxCapitalRiskPct: 2,
      note: 'Position sizing off stop distance is computed per-trade in the Portfolio screen; correlations shown here are vs. current book.',
    },
  };

  const schema = `{
  "ticker": string,
  "fiveLenses": {
    "valuation": { "read": string, "signal": "cheap"|"fair"|"expensive"|"unavailable" },
    "technicalStructure": { "read": string, "signal": "bullish"|"bearish"|"mixed"|"unavailable" },
    "macroGeopolitics": { "read": string, "signal": "tailwind"|"headwind"|"neutral"|"unavailable" },
    "flowSentiment": { "read": string, "signal": "supportive"|"unsupportive"|"mixed"|"unavailable" },
    "riskPortfolioFit": { "read": string, "signal": "fits"|"concentration_risk"|"unavailable" }
  },
  "bullCase": string,
  "bearCase": string,
  "whatKillsThisTrade": string,
  "conviction": number,
  "verdict": "BUY"|"WATCH"|"AVOID"
}`;

  const prompt = `Research ticker: ${symbol}

Here is the raw Five Lenses data gathered server-side (real feeds where available, marked unavailable where not):

${JSON.stringify(lenses, null, 2)}

Yinon's current portfolio tickers (for correlation/concentration context): ${portfolioTickers.length ? portfolioTickers.join(', ') : 'none yet'}

Produce your Five Lenses take on ${symbol} as JSON matching this schema exactly:
${schema}`;

  let brainAnalysis = null;
  let brainError = null;
  if (gemini.isConfigured()) {
    try {
      const text = await gemini.generate(SYSTEM_PERSONA, [{ role: 'user', content: prompt }], { json: true });
      brainAnalysis = JSON.parse(stripFences(text));
    } catch (err) {
      brainError = err.message;
    }
  } else {
    brainError = 'GEMINI_API_KEY not configured — showing raw Five Lenses data only. Add a free key from https://aistudio.google.com/apikey to your .env as GEMINI_API_KEY to get The Brain\'s narrative take.';
  }

  return {
    ticker: symbol,
    generatedAt: new Date().toISOString(),
    lenses,
    brainAnalysis,
    brainError,
  };
}

/**
 * Free-form chat with The Brain, given full portfolio + signals + market
 * context and persisted memory. Read-only: chat can discuss and recommend,
 * never execute.
 */
async function chat(userMessage, context) {
  const memorySummary = context.brain && context.brain.memory ? JSON.stringify(context.brain.memory) : '{}';
  const portfolioSummary = JSON.stringify(context.portfolio ? context.portfolio.positions : []);
  const signalsSummary = JSON.stringify(
    (context.signals && context.signals.items ? context.signals.items.slice(-10) : [])
  );

  const contextPreamble = `Current context you have access to:

Portfolio positions: ${portfolioSummary}
Recent pasted signals (last 10): ${signalsSummary}
Long-term memory you've accumulated about Yinon and open theses: ${memorySummary}

Remember: you can discuss, analyze, and recommend freely, including specific entries/exits/stop placements — but you never execute anything. If Yinon asks you to place or close a trade, remind him (briefly, once, without lecturing) that he executes every trade himself, then give him the analysis he'd need to do it.`;

  const history = (context.brain && context.brain.messages ? context.brain.messages.slice(-20) : []).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  history.push({ role: 'user', content: userMessage });

  const text = await gemini.generate(`${SYSTEM_PERSONA}\n\n${contextPreamble}`, history, { json: false });
  return text;
}

function stripFences(text) {
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

async function safe(fn) {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { researchTicker, chat, SYSTEM_PERSONA };
