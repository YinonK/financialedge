'use strict';

/**
 * Supabase storage adapter — talks to PostgREST over plain fetch.
 *
 * No npm dependency on purpose. Supabase exposes a REST API, so adding
 * @supabase/supabase-js would buy us nothing but install weight and another
 * thing to keep current.
 *
 * SHAPE OF THE DATA
 * The append-heavy collections live in their own tables, because they are the
 * ones that grow without bound and that we actually want to query:
 *   signals, analyses, journal_entries
 * Everything else — portfolio, settings, thresholds, brain memory, ingest
 * checkpoints, cost counters, the capped history lists — lives in one JSONB
 * row in app_state. Those are small, bounded, and always read together.
 *
 * That split matters: keeping 400 full Council transcripts inside a single
 * JSON blob would mean rewriting megabytes on every settings change, and
 * would make "show me every analysis of NVDA" a full-table scan in memory.
 */

const TABLE_STATE = 'app_state';
const TABLE_SIGNALS = 'signals';
const TABLE_ANALYSES = 'analyses';
const TABLE_JOURNAL = 'journal_entries';

const STATE_ROW_ID = 'main';

// How much history to hydrate into the in-memory context on each read.
// The full record stays in Postgres and is queryable via the API; this is
// just the working set the Council and UI need.
const HYDRATE_SIGNALS = 400;
const HYDRATE_ANALYSES = 150;
const HYDRATE_JOURNAL = 300;

function config() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
  return { url, key };
}

function isConfigured() {
  const { url, key } = config();
  return Boolean(url && key);
}

// A hung socket here would block the entire serialised write queue forever —
// Node's fetch has no default timeout, so give it one.
const REQUEST_TIMEOUT_MS = 20000;

async function rest(path, options = {}) {
  const { url, key } = config();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${options.method || 'GET'} ${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Reads the whole working context: the JSONB state row plus recent rows from
 * the three collection tables, reassembled into the same object shape the
 * rest of the app already expects.
 */
async function read(defaultContext) {
  const [stateRows, signals, analyses, journal] = await Promise.all([
    rest(`${TABLE_STATE}?id=eq.${STATE_ROW_ID}&select=data`),
    rest(`${TABLE_SIGNALS}?select=*&order=pasted_at.desc&limit=${HYDRATE_SIGNALS}`),
    rest(`${TABLE_ANALYSES}?select=*&order=ts.desc&limit=${HYDRATE_ANALYSES}`),
    rest(`${TABLE_JOURNAL}?select=*&order=ts.desc&limit=${HYDRATE_JOURNAL}`),
  ]);

  const state = (stateRows && stateRows[0] && stateRows[0].data) || {};
  const context = deepMerge(defaultContext, state);

  // Oldest-first in memory, matching the file adapter's ordering so nothing
  // downstream has to care which backend is in use.
  context.signals.items = (signals || []).map(rowToSignal).reverse();
  context.analyses.history = (analyses || []).map(rowToAnalysis).reverse();
  context.journal.entries = (journal || []).map(rowToJournal).reverse();

  return context;
}

/**
 * Writes the context back. Collections are diffed by id and only NEW rows are
 * inserted, so a routine settings save doesn't rewrite hundreds of rows — and
 * two Council runs finishing at once can't clobber each other's appends the
 * way a whole-file rewrite could.
 */
async function write(context, previous) {
  const prevSignalIds = new Set(((previous && previous.signals && previous.signals.items) || []).map((s) => s.id));
  const prevAnalysisIds = new Set(((previous && previous.analyses && previous.analyses.history) || []).map((a) => a.id));
  const prevJournalIds = new Set(((previous && previous.journal && previous.journal.entries) || []).map((j) => j.id));

  const newSignals = (context.signals.items || []).filter((s) => !prevSignalIds.has(s.id));
  const newAnalyses = (context.analyses.history || []).filter((a) => !prevAnalysisIds.has(a.id));
  // Journal entries mutate (an open decision gets an outcome), so upsert all
  // of them rather than only inserting new ones.
  const journalRows = (context.journal.entries || []).map(journalToRow);

  // Deletions must reach the tables too, or a deleted signal/journal entry
  // resurrects from Postgres on the next restart. Signals and journal are
  // never cap-trimmed in memory, so an id present before and absent now is a
  // real user delete. Analyses are EXCLUDED on purpose: memory keeps only the
  // newest 400 as a working set while the table keeps the full record, so a
  // shift() there is a trim, not a delete.
  const currentSignalIds = new Set((context.signals.items || []).map((s) => s.id));
  const currentJournalIds = new Set((context.journal.entries || []).map((j) => j.id));
  const deletedSignalIds = [...prevSignalIds].filter((id) => !currentSignalIds.has(id));
  const deletedJournalIds = [...prevJournalIds].filter((id) => !currentJournalIds.has(id));

  const jobs = [];

  const inFilter = (ids) => `in.${encodeURIComponent(`(${ids.map((id) => `"${id}"`).join(',')})`)}`;
  if (deletedSignalIds.length) {
    jobs.push(rest(`${TABLE_SIGNALS}?id=${inFilter(deletedSignalIds)}`, { method: 'DELETE' }));
  }
  if (deletedJournalIds.length) {
    jobs.push(rest(`${TABLE_JOURNAL}?id=${inFilter(deletedJournalIds)}`, { method: 'DELETE' }));
  }

  if (newSignals.length) {
    jobs.push(
      rest(TABLE_SIGNALS, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(newSignals.map(signalToRow)),
      })
    );
  }
  if (newAnalyses.length) {
    jobs.push(
      rest(TABLE_ANALYSES, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(newAnalyses.map(analysisToRow)),
      })
    );
  }
  if (journalRows.length) {
    jobs.push(
      rest(TABLE_JOURNAL, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(journalRows),
      })
    );
  }

  // The state blob, with the big collections stripped out — they live in tables.
  const stateBlob = { ...context };
  stateBlob.signals = { items: [] };
  stateBlob.analyses = { history: [] };
  stateBlob.journal = { entries: [] };
  stateBlob.meta = { ...(context.meta || {}), updatedAt: new Date().toISOString() };

  jobs.push(
    rest(TABLE_STATE, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ id: STATE_ROW_ID, data: stateBlob, updated_at: new Date().toISOString() }]),
    })
  );

  await Promise.all(jobs);
  return context;
}

// ---- row <-> object mapping ----
// Columns exist for the fields we filter/sort on; everything else rides along
// in a JSONB payload column so the schema doesn't need a migration every time
// a field is added.

function signalToRow(s) {
  return {
    id: s.id,
    pasted_at: s.pastedAt,
    source: s.source || null,
    tickers: s.tickers || [],
    raw_text: s.rawText || '',
    payload: { parsed: s.parsed || null },
  };
}
function rowToSignal(r) {
  return {
    id: r.id,
    pastedAt: r.pasted_at,
    source: r.source,
    tickers: r.tickers || [],
    rawText: r.raw_text || '',
    ...(r.payload || {}),
  };
}

function analysisToRow(a) {
  return {
    id: a.id,
    ts: a.ts,
    kind: a.kind,
    ticker: a.ticker,
    tickers: a.tickers || [],
    verdict_label: a.verdictLabel || null,
    conviction: a.conviction != null ? a.conviction : null,
    payload: a,
  };
}
function rowToAnalysis(r) {
  return r.payload || {
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    ticker: r.ticker,
    tickers: r.tickers || [],
    verdictLabel: r.verdict_label,
    conviction: r.conviction,
  };
}

function journalToRow(e) {
  return {
    id: e.id,
    ts: e.ts,
    ticker: e.ticker,
    action: e.action,
    status: e.status,
    payload: e,
  };
}
function rowToJournal(r) {
  return r.payload || { id: r.id, ts: r.ts, ticker: r.ticker, action: r.action, status: r.status };
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override !== undefined ? override : base;
  }
  if (typeof base === 'object' && base !== null && typeof override === 'object' && override !== null) {
    const out = { ...base };
    for (const key of Object.keys(override)) out[key] = deepMerge(base[key], override[key]);
    return out;
  }
  return override !== undefined ? override : base;
}

/** Connectivity + schema check used at startup and by /api/health. */
async function healthCheck() {
  try {
    await rest(`${TABLE_STATE}?select=id&limit=1`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { isConfigured, read, write, healthCheck, config };
