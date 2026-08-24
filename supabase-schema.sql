-- FinancialEdge — Supabase schema
--
-- Run this ONCE in your Supabase project:
--   Supabase dashboard -> SQL Editor -> New query -> paste this -> Run
--
-- Why this shape:
--   The three append-heavy collections (signals, analyses, journal entries)
--   get real tables, because they grow without bound and we actually want to
--   query them ("every analysis of NVDA", "signals from this channel").
--   Everything else — portfolio, settings, thresholds, brain memory, ingest
--   checkpoints, cost counters — is small, bounded, and always read together,
--   so it lives in one JSONB row. That avoids rewriting megabytes of Council
--   transcripts every time a setting changes.
--
--   Each table keeps a `payload` JSONB column alongside its indexed columns,
--   so adding a field to the app never requires a schema migration.

-- ---------------------------------------------------------------------------
-- 1. Everything small and bounded, in one row
-- ---------------------------------------------------------------------------
create table if not exists app_state (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. Signals — every message ingested from Telegram or pasted by hand
-- ---------------------------------------------------------------------------
create table if not exists signals (
  id          text primary key,
  pasted_at   timestamptz not null,
  source      text,
  tickers     jsonb not null default '[]'::jsonb,
  raw_text    text not null default '',
  payload     jsonb not null default '{}'::jsonb,  -- includes `parsed` extraction
  created_at  timestamptz not null default now()
);

create index if not exists signals_pasted_at_idx on signals (pasted_at desc);
create index if not exists signals_source_idx    on signals (source);
-- GIN index so "which signals mention NVDA" is a real indexed query
create index if not exists signals_tickers_idx   on signals using gin (tickers);

-- ---------------------------------------------------------------------------
-- 3. Analyses — every Council debate, including ones that never became trades
-- ---------------------------------------------------------------------------
create table if not exists analyses (
  id             text primary key,
  ts             timestamptz not null,
  kind           text,          -- research | convergence | opportunity | position_review
  ticker         text,
  tickers        jsonb not null default '[]'::jsonb,
  verdict_label  text,          -- BUY | WATCH | AVOID
  conviction     numeric,
  payload        jsonb not null default '{}'::jsonb,  -- full transcript: seats, catfish, verdict, cost
  created_at     timestamptz not null default now()
);

create index if not exists analyses_ts_idx      on analyses (ts desc);
create index if not exists analyses_ticker_idx  on analyses (ticker);
create index if not exists analyses_kind_idx    on analyses (kind);
create index if not exists analyses_tickers_idx on analyses using gin (tickers);

-- ---------------------------------------------------------------------------
-- 4. Journal — decisions and their realised outcomes
-- ---------------------------------------------------------------------------
create table if not exists journal_entries (
  id          text primary key,
  ts          timestamptz not null,
  ticker      text,
  action      text,          -- BUY | ADD | TRIM | EXIT | PASS | WATCH
  status      text,          -- open | closed
  payload     jsonb not null default '{}'::jsonb,  -- thesis, conviction, council snapshot, outcome
  created_at  timestamptz not null default now()
);

create index if not exists journal_ts_idx     on journal_entries (ts desc);
create index if not exists journal_ticker_idx on journal_entries (ticker);
create index if not exists journal_status_idx on journal_entries (status);

-- ---------------------------------------------------------------------------
-- 5. Security
-- ---------------------------------------------------------------------------
-- This is a single-user app and the server talks to Supabase with the SERVICE
-- key, which bypasses row-level security. RLS is still enabled on every table
-- so that if the anon key ever leaks (or you later expose these tables to a
-- browser), nothing is readable by default.
alter table app_state       enable row level security;
alter table signals         enable row level security;
alter table analyses        enable row level security;
alter table journal_entries enable row level security;

-- Deliberately NO permissive policies: with RLS on and no policy, the anon
-- key can read and write nothing. Only the service key gets through.
