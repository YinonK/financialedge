'use strict';

// Common all-caps words/acronyms that look like tickers but almost never are,
// so casual pasted text doesn't get flooded with false positives.
const STOPWORDS = new Set([
  'I','A','THE','AND','OR','FOR','TO','OF','IN','ON','AT','BY','IS','IT','BE','AS','AN','ARE','WAS',
  'CEO','CFO','CTO','COO','USA','US','UK','EU','GDP','CPI','FED','ETF','IPO','SEC','FOMC','ATH','ATL',
  'YOLO','FOMO','DD','TA','FA','EPS','PE','PEG','ROI','ROE','AI','ML','Q1','Q2','Q3','Q4','FY','YTD',
  'ATM','OTM','ITM','IV','RSI','MACD','DMA','WSB','TLDR','IMO','IMHO','FYI','ASAP','LOL','OMG',
]);

/**
 * Detects likely stock tickers in free-pasted text.
 * Matches: $TICKER (cashtag, always counted) or bare 1-5 uppercase-letter
 * words not in the stopword list, optionally with a single trailing
 * class letter like BRK.B.
 */
function detectTickers(text) {
  if (!text) return [];
  const found = new Set();

  const cashtagRe = /\$([A-Z]{1,5})\b/g;
  let m;
  while ((m = cashtagRe.exec(text)) !== null) {
    found.add(m[1]);
  }

  const bareRe = /\b([A-Z]{1,5}(?:\.[A-Z])?)\b/g;
  while ((m = bareRe.exec(text)) !== null) {
    const candidate = m[1];
    const base = candidate.split('.')[0];
    if (STOPWORDS.has(base)) continue;
    if (base.length < 1) continue;
    found.add(candidate);
  }

  return [...found];
}

module.exports = { detectTickers };
