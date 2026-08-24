'use strict';

/**
 * Multilingual entity + structured-claim extraction.
 *
 * WHY THIS EXISTS
 * Ticker detection used to be pure regex over [A-Z]{1,5}. Yinon's alpha
 * channels post in HEBREW, and Hebrew company names contain no Latin letters
 * at all — so "קבוצת דלק מדווחת על עלייה של 12% ברווח" matched nothing and
 * was stored with tickers: []. The message saved fine and looked healthy,
 * but it was invisible to the convergence detector, the opportunity hunt,
 * the watchdog's event trigger and per-ticker reflection. His best signal
 * source was flowing in and going nowhere, silently.
 *
 * This module replaces regex as the primary path with an LLM call that reads
 * Hebrew and English natively, names the companies, and maps them to tradeable
 * symbols. It also does the Stage C structured parsing in the SAME call —
 * corporate actions, guidance, regulatory dates, named price levels — because
 * we are already paying for the tokens and a second pass would be waste.
 *
 * COST CONTROL (without cutting quality):
 *   - regex fast path first: an explicit "$NVDA" needs no model call
 *   - messages are batched (default 10 per call), not one call each
 *   - resolved name→ticker mappings are cached, so a company that appears
 *     every week is resolved once
 *
 * HONESTY RULES baked into the prompt:
 *   - never invent a ticker. Unsure ⇒ ticker null + needsManualMapping
 *   - Tel Aviv listings are flagged, because Yahoo's coverage of them is
 *     poor and a mapped ticker may still have no price data
 */

const council = require('./council');
const { detectTickers } = require('../lib/tickerDetect');

const BATCH_SIZE = 10;
const HEBREW_RE = /[֐-׿]/;

function hasNonLatinScript(text) {
  return HEBREW_RE.test(text || '');
}

/**
 * Cheap pre-filter: does this message plausibly concern a company/market?
 * Avoids spending tokens on "good morning" style channel chatter.
 * Deliberately generous — a false positive costs a few tokens, a false
 * negative loses a signal.
 */
function looksFinancial(text) {
  if (!text || text.trim().length < 15) return false;
  const t = text.toLowerCase();
  const hebrewCues = [
    'מניה', 'מניות', 'רווח', 'הכנסות', 'דיבידנד', 'בורסה', 'שוק', 'חברה',
    'דוח', 'דוחות', 'צמיחה', 'תשואה', 'השקעה', 'אחזקות', 'עלייה', 'ירידה',
    'מיליון', 'מיליארד', 'רבעון', 'תחזית', 'הנפקה', 'רכישה',
  ];
  const englishCues = [
    'stock', 'shares', 'revenue', 'earnings', 'dividend', 'guidance', 'buyback',
    'upgrade', 'downgrade', 'target', 'profit', 'quarter', 'ipo', 'merger', '%', '$',
  ];
  return hebrewCues.some((c) => text.includes(c)) || englishCues.some((c) => t.includes(c));
}

const EXTRACTION_SCHEMA = `{
  "results": [
    {
      "index": number,                    // the message index you were given
      "language": "he"|"en"|"mixed"|"other",
      "isFinancial": boolean,             // false for greetings/off-topic chatter
      "entities": [
        {
          "nameAsWritten": string,        // exactly as it appears, Hebrew included
          "nameEnglish": string,          // best-known English name, "" if unsure
          "ticker": string|null,          // ONLY if you are confident. null otherwise.
          "exchange": "NASDAQ"|"NYSE"|"TASE"|"other"|null,
          "confidence": "high"|"medium"|"low",
          "needsManualMapping": boolean,  // true when ticker is null but it IS a real company
          "reasoning": string             // one short line: how you identified it
        }
      ],
      "corporateActions": [
        { "type": "dividend"|"buyback"|"split"|"capital_raise"|"merger"|"acquisition"|"other",
          "detail": string, "amount": string|null, "yieldPct": number|null, "date": string|null }
      ],
      "guidance": [
        { "metric": string, "direction": "raised"|"lowered"|"maintained"|"new", "detail": string }
      ],
      "productionMetrics": [ { "metric": string, "value": string, "period": string|null } ],
      "regulatoryTimeline": [
        { "event": string, "date": string, "significance": string }
      ],
      "namedPriceLevels": [
        { "ticker": string|null, "level": number, "type": "support"|"resistance"|"target"|"stop", "quote": string }
      ],
      "numericClaims": [ { "claim": string, "value": string } ],
      "summaryEnglish": string            // 1-2 plain sentences, B2 level
    }
  ]
}`;

function buildPrompt(batch, knownMappings) {
  const cacheHint = Object.keys(knownMappings).length
    ? `\n\nCompany names we have already mapped before (reuse these, do not re-derive):\n${JSON.stringify(
        knownMappings,
        null,
        2
      )}`
    : '';

  return `Extract structured information from these financial messages. They come from Israeli Telegram channels and are OFTEN IN HEBREW.

CRITICAL RULES:
1. Hebrew company names must be recognised. Examples of the kind of thing you will see: "קבוצת דלק" (Delek Group), "נקסט ויז'ן" (Nextvision), "אנבידיה" (Nvidia), "טבע" (Teva). Identify the company even when no Latin ticker appears anywhere in the text.
2. NEVER invent a ticker. If you are not confident of the exact trading symbol, set ticker to null, set needsManualMapping to true, and explain in reasoning. A wrong ticker is far worse than no ticker — it would put a real position's analysis onto the wrong company.
3. Israeli companies usually trade on the Tel Aviv Stock Exchange (TASE). Mark exchange "TASE". Some also have US listings — if the message is about the US listing, give the US symbol.
4. A message can mention several companies, or none.
5. Extract numbers exactly as claimed. These are CLAIMS from a channel, not verified facts — you are recording what was said, not endorsing it.
6. summaryEnglish must be plain, simple English (CEFR B2), because Yinon reads it.

Messages:
${batch.map((m, i) => `--- MESSAGE ${i} (source: ${m.source || 'unknown'}) ---\n${m.rawText}`).join('\n\n')}${cacheHint}

Respond ONLY with valid JSON matching this schema exactly. No markdown fences, no prose outside the JSON:
${EXTRACTION_SCHEMA}`;
}

function stripFences(text) {
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

function tryParse(text) {
  const cleaned = stripFences(text);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch (e) {
        return null;
      }
    }
    return null;
  }
}

/**
 * Extracts entities and structured claims for a list of message-like objects
 * ({ rawText, source }). Returns one enrichment per input, index-aligned.
 *
 * Falls back to regex-only enrichment if no AI provider is available, so
 * ingestion never breaks — it just stays as limited as it was before.
 */
async function extractFromMessages(messages, options = {}) {
  const knownMappings = options.knownMappings || {};
  const results = new Array(messages.length).fill(null);

  // --- Fast path: pure-Latin messages where regex already finds tickers ---
  const needsLlm = [];
  messages.forEach((m, i) => {
    const text = m.rawText || '';
    const regexTickers = detectTickers(text);
    const hebrew = hasNonLatinScript(text);

    if (!hebrew && regexTickers.length) {
      // Plain English with explicit symbols — no model call needed.
      results[i] = {
        tickers: regexTickers,
        entities: regexTickers.map((t) => ({
          nameAsWritten: t,
          nameEnglish: t,
          ticker: t,
          exchange: null,
          confidence: 'high',
          needsManualMapping: false,
          reasoning: 'explicit ticker symbol in the text',
        })),
        extractionMethod: 'regex',
        language: 'en',
      };
      return;
    }
    if (!looksFinancial(text)) {
      results[i] = { tickers: regexTickers, entities: [], extractionMethod: 'skipped_non_financial', language: hebrew ? 'he' : 'en' };
      return;
    }
    needsLlm.push(i);
  });

  if (!needsLlm.length) return { enrichments: results, llmCalls: 0, newMappings: {} };

  if (!council.anyConfigured()) {
    // Degrade honestly rather than silently: keep regex output, flag the gap.
    for (const i of needsLlm) {
      results[i] = {
        tickers: detectTickers(messages[i].rawText || ''),
        entities: [],
        extractionMethod: 'regex_only_no_ai',
        note: 'No AI provider configured, so Hebrew company names could not be identified.',
      };
    }
    return { enrichments: results, llmCalls: 0, newMappings: {} };
  }

  // --- LLM path, batched ---
  const newMappings = {};
  let llmCalls = 0;

  for (let start = 0; start < needsLlm.length; start += BATCH_SIZE) {
    const idxBatch = needsLlm.slice(start, start + BATCH_SIZE);
    const batch = idxBatch.map((i) => messages[i]);

    try {
      const raw = await council.chairGenerate(
        'You extract structured financial information from multilingual messages, especially Hebrew. You are precise and you never guess a ticker symbol.',
        [{ role: 'user', content: buildPrompt(batch, knownMappings) }],
        { json: true, maxOutputTokens: 16384 }
      );
      llmCalls++;
      const parsed = tryParse(raw);
      const rows = (parsed && parsed.results) || [];

      idxBatch.forEach((globalIdx, localIdx) => {
        const row = rows.find((r) => r.index === localIdx) || rows[localIdx];
        if (!row) {
          results[globalIdx] = {
            tickers: detectTickers(messages[globalIdx].rawText || ''),
            entities: [],
            extractionMethod: 'llm_no_row',
          };
          return;
        }

        const entities = row.entities || [];
        const tickers = [...new Set(entities.map((e) => e.ticker).filter(Boolean))];

        // Cache confident mappings so we stop paying to re-resolve them.
        for (const e of entities) {
          if (e.ticker && e.confidence === 'high' && e.nameAsWritten) {
            newMappings[e.nameAsWritten] = { ticker: e.ticker, exchange: e.exchange || null };
          }
        }

        results[globalIdx] = {
          tickers,
          entities,
          language: row.language,
          isFinancial: row.isFinancial !== false,
          corporateActions: row.corporateActions || [],
          guidance: row.guidance || [],
          productionMetrics: row.productionMetrics || [],
          regulatoryTimeline: row.regulatoryTimeline || [],
          namedPriceLevels: row.namedPriceLevels || [],
          numericClaims: row.numericClaims || [],
          summaryEnglish: row.summaryEnglish || '',
          unmappedCompanies: entities.filter((e) => !e.ticker && e.needsManualMapping).map((e) => e.nameAsWritten),
          extractionMethod: 'llm',
        };
      });
    } catch (err) {
      console.error('[entityExtract] batch failed:', err.message);
      for (const i of idxBatch) {
        results[i] = {
          tickers: detectTickers(messages[i].rawText || ''),
          entities: [],
          extractionMethod: 'llm_failed',
          note: `Extraction failed: ${err.message.slice(0, 160)}`,
        };
      }
    }
  }

  return { enrichments: results, llmCalls, newMappings };
}

module.exports = { extractFromMessages, looksFinancial, hasNonLatinScript, BATCH_SIZE };
