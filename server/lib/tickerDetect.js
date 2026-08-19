'use strict';

// Common all-caps words/acronyms that look like tickers but almost never are,
// so casual pasted text doesn't get flooded with false positives.
const STOPWORDS = new Set([
  'I','A','THE','AND','OR','FOR','TO','OF','IN','ON','AT','BY','IS','IT','BE','AS','AN','ARE','WAS',
  'CEO','CFO','CTO','COO','USA','US','UK','EU','GDP','CPI','FED','ETF','IPO','SEC','FOMC','ATH','ATL',
  'YOLO','FOMO','DD','TA','FA','EPS','PE','PEG','ROI','ROE','AI','ML','Q1','Q2','Q3','Q4','FY','YTD',
  'ATM','OTM','ITM','IV','RSI','MACD','DMA','WSB','TLDR','IMO','IMHO','FYI','ASAP','LOL','OMG',
  // Firms, institutions, agencies and media outlets that read like tickers but aren't
  // listed under those letters. Auto-ingested channel posts surface these constantly.
  'KPMG','EY','PWC','BCG','IMF','WTO','OPEC','NATO','UN','EIA','BLS','BEA','FDA','FTC','DOJ','IRS',
  'CNBC','WSJ','FT','BBC','CNN','NYT','AP','PR','IPO','MA','LBO','IPOS','ESG','KYC','AML',
  'PMI','ISM','PCE','PPI','NFP','QE','QT','BOJ','ECB','BOE','SNB','RBA','PBOC',
  'EOD','EOY','EOM','WTD','MTD','QTD','YOY','QOQ','MOM','TTM','CAGR','EBIT','FCF','NAV','AUM',
  'CFD','FX','OTC','NYSE','SPX','NDX','DJIA','VIX','SP','DAX','FTSE','TASE','TA35','TA125',
  'BTC','ETH','USD','EUR','GBP','JPY','ILS','CHF','CAD','AUD','NIS',
  'HR','IT','RD','QA','KPI','OKR','SLA','B2B','B2C','SAAS','API','APP','PC','TV','VR','AR','LLM','GPT',
  'OK','NO','YES','NEW','NOW','ALL','ONE','TWO','TOP','BIG','LOW','HIGH','BUY','SELL','HOLD','LONG','SHORT',
  'IF','SO','UP','DO','WE','HE','MY','ME','US','AM','PM','ET','EST','PST','GMT','UTC',
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
