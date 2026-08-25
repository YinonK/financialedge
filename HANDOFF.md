# FinancialEdge — Project Handoff

**Purpose of this document:** paste into a fresh AI session with zero prior context. Everything here was verified against the live codebase, the running production deployment, and the actual Supabase state on the date below — not recalled from memory.

**Verified:** 2026-08-25 against commit `2f0bc6e`, production `https://financialedge.onrender.com`.

---

## 1. What this is

A personal investment intelligence platform built for one user, **Yinon**:

- Israeli investor trading **US equities**
- **Bold / high-risk** tolerance, **macro-first** thinker
- Concentrated book: **~5 positions maximum**
- Horizon: **weeks to months** (not day trading, not multi-year buy-and-hold)
- Tracks P&L in **both USD and ILS**
- English is not his first language → all user-facing text is written at **CEFR B2** level

### The non-negotiable principle

**The system is read-only with respect to any broker or exchange. It never trades, never places/modifies/cancels an order, and never auto-triggers a stop loss — not even as a "safety" feature. Yinon executes every trade himself.**

This is enforced in the system prompts of every Council seat and is stated in the header comment of every service that touches positions. If you extend this project, preserve that boundary — it is the entire design premise, not a caveat.

---

## 2. Architecture

| Layer | Choice |
|---|---|
| Backend | Node.js 18+ / Express 4 (CommonJS) |
| Frontend | Vanilla JS + plain `<script>` tags. **No build step, no framework, no bundler** |
| Hosting | Render.com, **free tier** |
| Storage | **Supabase** (Postgres via PostgREST) — confirmed live |
| Repo | `https://github.com/YinonK/financialedge` |
| Deploys | **Push to `main` → Render auto-deploys.** No manual deploy step |

### Dependencies (deliberately minimal)
`express`, `dotenv`, `telegram` (GramJS, for reading Telegram channels). That's it. Supabase is reached over plain `fetch` against its REST API — no SDK, on purpose.

### Why Supabase instead of a Render disk

Render's free tier has **no persistent disk**. State originally lived in `data/context.json`, which meant **every redeploy wiped everything** — signals, decision journal, analysis history. This was discovered in production: 89 ingested signals and all journal entries were gone after a few deploys. A learning loop that forgets on every deploy cannot learn. Yinon chose Supabase's free tier over paying ~$7/mo for a Render disk, consistent with the project's pattern of using free external services.

### Storage design (`server/lib/storage/`)

Adapter pattern with two backends, selected automatically:
- `supabaseAdapter.js` — used when `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` are set
- `fileAdapter.js` — local dev, and a **fallback safety net** if Supabase write fails
- `index.js` — the facade

**Important design note:** all ~15 route files call `readContext()` / `writeContext()` **synchronously**. Supabase is async. Rather than rewrite every call site, the facade holds the authoritative context **in memory**, serves reads instantly, and pushes durable writes through a **serialised queue** (which also fixed a pre-existing race where two concurrent Council runs could clobber each other).

**Known limitation, stated honestly:** if the process is killed between an in-memory write and its flush, that write is lost. `SIGTERM`/`SIGINT` trigger a final flush, and the window is small. For a single-user tool the worst case is losing one signal that a re-run recreates.

**Table split rationale:** the three append-heavy, queryable collections (`signals`, `analyses`, `journal_entries`) get real tables with indexes (including **GIN indexes on `tickers`** so "every analysis mentioning NVDA" is a real indexed query). Everything else — portfolio, settings, thresholds, brain memory, ingest checkpoints, cost counters, capped history lists — is small, bounded, and always read together, so it lives in **one JSONB row** in `app_state`. Keeping 400 full Council transcripts inside a single JSON blob would mean rewriting megabytes on every settings change.

Each table also carries a `payload` JSONB column alongside indexed columns, so adding an app field never requires a schema migration.

Schema lives in **`supabase-schema.sql`** at the repo root (already applied to the live project). RLS is enabled on all four tables with **no permissive policies** — only the service key gets through.

---

## 3. The Council

The analytical core. Not "ask an LLM what it thinks" — a structured adversarial process.

### Research basis

Two findings drove the design:

1. **Coordination structure beats model count** (TradingAgents-style multi-agent trading literature). Five models all asked "what do you think of NVDA?" converge on mush. Five models each given an *adversarial mandate* surface disagreement that a consensus prompt averages away. The reference framework keeps Fundamentals / Sentiment / News / Technical as **distinct** seats rather than merging them.

2. **Devil's advocate framing matters enormously.** A soft instruction ("be critical", "play devil's advocate") produces genuine disagreement only ~55% of the time — barely above baseline agreeableness. An **explicit hard behavioural assignment** ("your role is mandatory opposition; you must argue the Council is wrong") produces ~99%. The Catfish seat is written as an assigned *duty*, never as a disposition.

### The 8 seats

| Seat | Provider (3 configured) | Why that model |
|---|---|---|
| **Bull Analyst** | Claude Sonnet 5 | Strong reasoning for building the strongest honest case FOR |
| **Bear Analyst** | GPT-5.6 Terra | **Forced onto a different model from Bull** (`opposes: 'bull'`) so the adversarial split is two genuinely different models, not one arguing with itself |
| **Risk Manager** | Claude Sonnet 5 | Capital preservation; carries **veto weight** — "unacceptable" forces AVOID/WATCH regardless of the bull case |
| **Fact-Checker** | GPT-5.6 Terra (`specialist`) | GPT leads on hallucination-resistance in financial benchmarks — this seat's entire job |
| **Macro Analyst** | Gemini Pro (`specialist`) | Top-down view; the only seat that can say something useful when a signal has **no ticker at all**. (Formerly named "Live-Web Analyst" — renamed honestly: no live search grounding is wired in; the seat sees prompt data + training knowledge) |
| **Sentiment Analyst** | Gemini Pro | Crowd psychology, crowding, hype-cycle stage, promotional tells. **Deliberately NOT merged with Macro** — "the crowd is euphoric" and "the Fed is hawkish" point in different directions |
| **CFO (chair)** | Claude Sonnet 5 | Synthesises; must keep **verified facts separate from unverified signal claims** and surface real disagreement |
| **Catfish** | GPT-5.6 Terra | Mandatory opposition, runs **after** the CFO draft, on a **different model from the chair** — a seat attacking a draft it wrote itself is compromised |

Assignment is a **two-pass algorithm** in `server/services/roles.js`: specialists get their preferred model first, then generalists spread across remaining providers by least-loaded, with the Bull/Bear constraint applied. With only one provider configured, one model plays every seat — still worthwhile, because the adversarial structure lives in the prompts.

### Flow

1. All 6 analyst seats deliberate **in parallel**, each under its own mandate
2. **CFO** synthesises a draft verdict
3. **Catfish** attacks the draft; checks for groupthink, unexamined shared assumptions, and "laundered claims" (unverified channel numbers that became load-bearing)
4. If Catfish sets `demandsRevision: true`, a **second CFO pass is forced** — it must revise or explicitly justify rejecting the objection

Typical run: **8–9 model calls, ~2–3 minutes.**

**The Five Lenses** (valuation / technical structure / macro & geopolitics / flow & sentiment / risk & portfolio fit) are folded into each seat's mandate as the analytical checklist they draw on — *not* run as a separate pass.

**Degradation is honest:** failed seats are dropped **and named to the CFO** so it cannot pretend they agreed. `chairGenerate()` fails over to another provider if the chair is down.

### Verified working in production
A live NVDA run produced genuine disagreement: Bull conviction 5 vs Bear conviction 6 reading the *same* technical facts; Macro said "headwind" while Sentiment said "euphoric/warning"; the Catfish challenged the macro causal chain and **forced a revision** that moved conviction 3 → 4. Final: WATCH, conviction 4/10, alignment "split".

### Cost tracking & budget guard

`server/services/costTracker.js`. Providers report **real token usage** (not string-length estimates) via an `onUsage` callback. Since the 2026-08-25 hardening pass **every** LLM path is metered — full Council runs *and* brain chat, morning briefing, weekly review, journal reflection, watchdog quick takes, and Hebrew entity extraction (`costTracker.metered()` wraps each). Priced against an editable rate table:

| Provider | Input $/1M | Output $/1M | Status |
|---|---|---|---|
| Gemini Pro | 1.00 | 6.00 | default |
| Claude Sonnet 5 | 2.00 | 10.00 | **ESTIMATE — verify against a real invoice** |
| GPT-5.6 Terra | 2.00 | 12.00 | confirmed |

Monthly accumulation + straight-line month-end projection. **Soft guard: $30/month default.** When projected spend crosses 80% of the ceiling it sends **one warning per day** via Telegram and shows it in-app. **It never drops seats, shortens prompts, or downgrades models.** This is explicit in the code and the warning text — a system that quietly gets weaker to save money is worse than one costing a few dollars more, because you stop being able to trust what you're reading.

Rates are overridable from Settings without a code change.

---

## 4. Screens

Eight screens (nav order in `public/js/shared.js`):

1. **Home** (`index.html`) — morning briefing, portfolio snapshot, live market indicators with confluence alerts, AI spending summary, Brain Operations panel (per-provider health with plain-language fix hints)
2. **Portfolio** (`portfolio.html`) — CRUD for up to 5 positions, live P&L in USD + ILS, stop/target zone bar, latest Council review per position, on-demand "Council review" button
3. **Research** (`research.html`) — full 8-seat Council on any ticker; renders per-seat output, the verified-vs-unverified split, the Catfish opposition block, watch dates
4. **Signals** (`signals.html`) — manual paste, ticker/entity detection, convergence report, signal history
5. **Journal** (`journal.html`) — decision journal, outcome recording, calibration scorecard, "ask the Brain to grade itself"
6. **Analyses** (`analyses.html`) — browsable/filterable history of every Council debate, per-ticker timeline showing how the view evolved, permalinks (`?id=`)
7. **Brain Chat** (`brain.html`) — free-form chat with full portfolio/signals/memory context
8. **Settings** (`settings.html`) — see below

### Market indicators (Home)

Blue-bordered tiles = Yinon's thresholds; gold-bordered = the Brain's macro thresholds. Every tile has a "?" explainer (what it is / how to read it / why it matters / historical example). Confluence alert fires at 2+ red.

Live: Fear & Greed (<15), VIX (>30, watch >20), consecutive S&P red days (≥3), US 10Y (>4.5%), DXY (>105), gold spike (>2%), WTI move (>3%).
**Permanently N/A with manual-check instructions (no free feed):** S5FI, Put/Call ratio, A/D divergence, AAII bears. These are **never estimated or faked.**

### Settings — what's configurable

| Setting | Enforced? |
|---|---|
| Budget ceiling (USD) + warn threshold | ✅ Yes |
| Position review cadence (1/3/7 days or off) | ✅ Yes |
| Model price overrides | ✅ Yes |
| Opportunity hunt candidate count | ✅ Yes (1–10, read by `huntCandidates`) |
| Opportunity hunt cadence days | ✅ Yes — hunt route self-checks "has it been N days?"; 0 disables |
| `fullCouncilPaths` per-path toggles | ✅ Yes — `false` runs a light bench (Bull/Bear/Risk, no Catfish, ~half the calls) via `council.depthForPath()` |

All three former gaps were closed in the 2026-08-25 hardening pass.

---

## 5. Data sources

| Source | Used for | Status |
|---|---|---|
| **Yahoo Finance** (unofficial chart + quoteSummary) | Prices, 50/200 DMA, RSI, MACD, Fibonacci, volume, valuation, analyst/short/insider data, trending list | Working. Chart endpoint reliable; **quoteSummary is often bot-blocked** → valuation/flow frequently come back `available: false`, which is surfaced honestly, never faked |
| **CNN Fear & Greed** (dataviz endpoint) | Sentiment index | Working |
| **frankfurter.app** | USD/ILS FX | Working (redirects to frankfurter.dev; `fetch` follows) |
| **Telegram channels** (MTProto/GramJS) | Primary alpha source | Working — 4 channels |
| **Marketaux** | Macro news | ❌ **NOT BUILT.** No key requested, no code references it |

### Telegram channels ingested
`liorvider1`, `uranusupdates`, `bensamocha`, `Cryptyto`

**These post in HEBREW.** This mattered enormously — see next section.

### Hebrew entity extraction (critical fix)

**The bug:** ticker detection was pure regex over `[A-Z]{1,5}`. Hebrew company names contain no Latin letters, so `"קבוצת דלק מדווחת על עלייה של 12% ברווח"` matched **nothing** and saved with `tickers: []`. The message stored fine and looked healthy — but was invisible to the convergence detector, opportunity hunt, watchdog event triggers, and per-ticker reflection. **His best signal source was flowing in and going nowhere, silently.**

**The fix** (`server/services/entityExtract.js`): LLM-based extraction replaces regex as the primary path.

- Reads Hebrew and English natively, names the company, maps it to a symbol
- **Never invents a ticker.** Unsure → `ticker: null` + `needsManualMapping: true`. A wrong ticker would run analysis on the wrong company — far worse than no ticker
- Flags **TASE** listings, because Yahoo's Israeli coverage is poor — a name can map correctly and still have no price data
- Also performs **Stage C structured parsing in the same call**: corporate actions (dividends/buybacks/splits/raises), guidance changes, production metrics, regulatory timeline with dates, named support/resistance levels, numeric claims

**Cost control without quality loss:** regex fast-path for explicit `$TICKER` (zero model calls), batching (10 messages/call), a non-financial pre-filter (skips "בוקר טוב"), and a persistent name→ticker cache in `entityCache.mappings`.

**Verified in production:** `"קבוצת דלק"` → Delek Group → `DLEKG` / TASE, persisted through Supabase.

### Source attribution (`server/services/provenance.js`)

Threaded through Research, convergence, and position reviews. Tells the Council explicitly which data is verified fact (app-computed / market feed) versus an **unverified channel claim**, and warns when N mentions all came from **one** channel — "one opinion repeated, not independent agreement."

---

## 6. Automation

### cron-job.org jobs

All POST with header `X-Cron-Key: <CRON_KEY>`, except the ping (GET, no header).

| Job | Endpoint | Schedule | Status |
|---|---|---|---|
| Morning briefing | `/api/briefing` | Weekdays 07:30 Israel | ✅ Live |
| Opportunity hunt | `/api/opportunities` | Weekdays ~16:00 Israel | ✅ Live |
| Weekly review | `/api/review/weekly` | Saturdays ~10:00 Israel | ✅ Live |
| Telegram ingest | `/api/signals/ingest` | Every 15 min | ✅ Live |
| **Position review sweep** | `/api/positions/review-due` | Daily ~17:00 Israel | ✅ Live |
| **Keep-alive ping** | `/api/ping` | Every 10 min (GET) | ✅ Live |
| **Backup export** | `/api/backup` | Weekly (e.g. Sundays) | ⚠️ **NEW — needs a cron-job.org entry.** Sends the full working context as a JSON file to Yinon's Telegram chat (Supabase free tier has no point-in-time recovery) |

**Failure alerting:** every cron route now sends one Telegram line if it 500s (`reportCronFailure`), so a silently broken job surfaces the day it breaks.

**Why the ping matters:** Render's free tier sleeps after ~15 min idle; cold start is 30–60s, which exceeds cron-job.org's 30s timeout. The 15-min ingest job sits right on that boundary, causing intermittent 503s. A 10-min ping keeps it warm.

**Long runs no longer look like failures.** A full Council run takes ~2–3 minutes, well past cron-job.org's 30s timeout. This was written off as cosmetic; it was not. Recorded timeouts count toward cron-job.org's auto-disable threshold, which is how the Signal Ingest and Watchdog jobs silently died for five days in Aug 2026. Every cron endpoint now acknowledges with **202 immediately** and finishes the work in the background (`server/lib/asyncCron.js`), reporting the real result over Telegram as always. Cheap "nothing to do" guards (market hours, cadence not due) still answer definitively before the handoff. Add `?wait=true` to any of them to block for the full result when testing by hand. One run per job at a time — a hung provider can't stack up paid Council runs. In-flight runs show in `/api/health` under `runningJobs`.

**Cadence self-check design:** `/api/positions/review-due` asks each position "has it been N days since I was last reviewed?" So changing the cadence in Settings takes effect immediately with **no cron-job.org change needed**. Capped at 2 positions per run (a review is ~8 model calls).

### Watchdog (`/api/watchdog`)
Price mechanics only — stop breached, stop approaching, target hit, plus market confluence. Server-side US-market-hours gate (`?force=true` to override). **Read-only.**

### Event-triggered position reviews
The watchdog also detects material events on held names and fires an immediate single-position Council re-underwriting:
1. Fresh channel chatter mentioning a held ticker (deduped by signal ID so one post fires one review)
2. Price testing/breaking a structural level — 200 DMA or 0.5/0.618 Fibonacci (deduped per level with a 7-day cooldown, so a price *hovering* at its 200 DMA is one event, not one paid review per tick)

Capped at one per tick. Convergence alerts from ingest are similarly deduped: a Council run fires when a convergence is new, escalates to strong, or resurfaces after 7 days — not on every additional mention.

### Portfolio Council Review
Distinct from both the watchdog (price only) and weekly review (backward-looking). **Forward-looking and thesis-based:** pulls the original journal entry (thesis, conviction, Council read at entry) and asks *"is what we believed still true?"* Returns an explicit **INTACT / WEAKENING / BROKEN** status plus "what changed since entry". Catches the failure where a position sits happily between stop and target while the reason for owning it quietly dies.

---

## 7. The learning loop

This is what makes the system improve rather than re-litigate every name from scratch.

### Analysis store (`server/services/analysisStore.js`)
**Every** Council run is persisted with its full transcript — research, convergence, opportunity hunt, position review — via one `recordAnalysis()`. Previously only position reviews were saved; a ~3-minute, 8-call research debate was rendered once and lost forever.

### Reflection (`server/services/reflection.js`)
Before the Council debates a ticker, it receives:
1. **All prior analyses of that ticker** — including looks that never became trades (most analysis doesn't)
2. **Drift detection**, self-reported: *"Over 3 looks our conviction has warmed up (4 → 7). The verdict moved from WATCH to BUY. If you are about to repeat the same conclusion, say what new evidence supports it — or say plainly that nothing has changed."*
3. **Actual decisions taken** on that name and how they turned out
4. **Cross-ticker calibration lesson** — but **only when the sample supports it**

**Sample-size discipline matters here.** Below 6 closed decisions (and 3 per bucket) it explicitly refuses: *"too few to draw calibration lessons from yet — do not treat this as a pattern."* Feeding a fake pattern would make calibration *worse*, not better. When it does assert something, it always attaches `n=`.

### Decision journal + scorecard (`server/services/journal.js`)
Freezes the Council's read **at decision time** (verdict, conviction, whether unanimous or split), then reconciles against realised P&L on close. Opening a position auto-logs; closing auto-reconciles using the live quote.

Scorecard slices by the things that would change behaviour:
- **By conviction** — does confidence actually predict outcomes?
- **By Council alignment** — **is a split Council a real warning sign?** (arguably the most valuable thing this system can learn about itself)
- **By verdict** — do BUYs beat WATCHes?

Plus hit rate, total P&L, and **expectancy per decision**.

---

## 8. Telegram integration

Bidirectional via webhook (`/api/telegram/webhook`), auto-registered at startup using Render's `RENDER_EXTERNAL_URL`.

### Commands (`server/services/telegramCommands.js`) — BUILT ✅
| Command | Behaviour |
|---|---|
| `/help` | Capabilities in B2 plain English. **No model call** |
| `/status` | Provider health, spend vs budget, open positions, last run times, channels. **No model call** |
| `/ask <question>` | Forwards to the Brain |
| Bare text | Goes to the Brain as chat (unchanged) |
| Unknown `/xyz` | Friendly "I don't know that command" |

Handles the `@BotName` suffix Telegram appends in groups. Only messages from the exact `TELEGRAM_CHAT_ID` are processed. Optional `TELEGRAM_WEBHOOK_SECRET` adds header validation.

**Verified:** command routing tested for all cases. **Not yet verified: a real end-to-end round-trip from Yinon's phone** — worth confirming by sending `/status` to the bot.

### Telegram vs app split
Telegram gets **headline + key takeaway + deep link**; the full debate transcript lives in the app at `/analyses.html?id=<id>` where it can be read and questioned. Position review and opportunity hunt alerts deep-link correctly.

### B2 plain-language persona — BUILT ✅
Baked into `SHARED_CONTEXT` (all Council seats, `roles.js`) and `SYSTEM_PERSONA` (chat/briefing, `brain.js`): short sentences, everyday words over jargon, brief plain-language gloss on first use of terms like P/E, RSI, DMA. Explicitly scoped to **how it writes, never how hard it thinks** — analytical depth is unchanged.

---

## 9. What is genuinely NOT built / known limitations

Verified by grepping the actual codebase, not recalled.

### Not built at all
- **Stage E — Marketaux macro news ingestion.** Zero code references. No API key requested. This is the gap that means a macro catalyst with no ticker (Fed decision, tariff ruling, bond move) has no dedicated feed. The Macro seat can still reason about it from indicators, but there's no news pipeline.
- **Earnings/news event detection** for event-triggered reviews. Only signal-chatter and level-break triggers exist. This was deferred pending Marketaux.

### Built but NOT wired up
- **Stage D — named price levels from signals are extracted but ignored.** `entityExtract.js` produces `namedPriceLevels` (support/resistance quoted in the Hebrew posts themselves), but `watchdog.js` only checks computed 200 DMA / Fibonacci levels. Wiring these together is a small, high-value change.
- ~~`fullCouncilPaths` / `opportunityHuntCandidates` / `opportunityHuntCadenceDays` not enforced~~ — **fixed 2026-08-25**, all three are enforced now (see §4).

### Known limitations
- **Yahoo `quoteSummary` is frequently bot-blocked**, so valuation and flow/sentiment lenses often return `available: false`. Handled honestly (never faked) but it means two of the Five Lenses are regularly dark.
- **Claude Sonnet 5 pricing is an estimate** ($2/$10 per 1M). Verify against a real Anthropic invoice and correct in Settings → Model prices.
- ~~Full Council runs exceed cron-job.org's 30s timeout~~ — **fixed 2026-08-25**: cron endpoints return 202 and finish in the background, so a long run is no longer recorded as a failure (see §6).
- **In-memory write window** — see §2.
- **TASE tickers may extract correctly but have no Yahoo price data.**
- **Provider health shows `untested` after each redeploy** — it's in-memory since last boot, not persisted.
- **Production data is currently near-empty** (0 signals, 0 analyses, 0 journal entries) because Supabase was only just connected and everything prior was lost to the ephemeral-disk problem. **The learning loop starts accumulating from now.**

---

## 10. Environment variables

Names only — never commit or paste values. `.env` is git-ignored; `.env.example` documents all of these.

### Confirmed set on Render (verified via `/api/health`)
| Var | Evidence |
|---|---|
| `GEMINI_API_KEY` | Provider listed live |
| `GEMINI_MODEL` | Resolves to `gemini-pro-latest` |
| `ANTHROPIC_API_KEY` | Provider listed live |
| `OPENAI_API_KEY` | Provider listed live |
| `SUPABASE_URL` | `storage.backend === "supabase"` |
| `SUPABASE_SERVICE_KEY` | Same |
| `TELEGRAM_BOT_TOKEN` | `telegramOutboundConfigured: true` |
| `TELEGRAM_CHAT_ID` | Same |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_SESSION` | `telegramIngestConfigured: true` |
| `TELEGRAM_CHANNELS` | 4 channels returned |
| `CRON_KEY` | Cron jobs authenticate successfully |

### Optional / not set
| Var | Purpose |
|---|---|
| `OPENAI_MODEL` | Defaults to `gpt-5.6-terra` |
| `ANTHROPIC_MODEL` | Defaults to `claude-sonnet-5` |
| `AI_CHAIR` | Which provider chairs; defaults to Claude |
| `ANTHROPIC_TEMPERATURE` | **Opt-in only** — temperature is deprecated on Sonnet 5 and sending it is a hard 400 |
| `OPENAI_MIN_COMPLETION_TOKENS` | Defaults to 32000 |
| `OPENAI_REASONING_EFFORT` | Opt-in |
| `APP_KEY` | ⚠️ **NEW — set this.** Locks every user-facing API route (browser sends it as `X-App-Key`, asked once and kept in localStorage). Unset = API is open to anyone with the URL, with a loud startup warning |
| `TELEGRAM_WEBHOOK_SECRET` | Extra webhook validation; **defaults to `CRON_KEY`** since 2026-08-25, so the webhook is authenticated even without it |
| `PUBLIC_BASE_URL` | Local/ngrok override; Render sets `RENDER_EXTERNAL_URL` automatically |
| `BRIEFING_KEY` | Legacy alias for `CRON_KEY`, still accepted |
| `MARKETAUX_API_KEY` | ❌ **Not set, not used — Stage E not built** |

---

## 11. Key decisions log

| # | Decision | Reasoning |
|---|---|---|
| 1 | **Render free tier** over Railway / Fly.io / paid VM | Real permanent free tier. Accepted cost: sleeps when idle, needs an external cron ping |
| 2 | **cron-job.org** for all scheduling | A scheduler inside a sleeping dyno can't wake itself |
| 3 | **Vanilla JS, no build step** | Single-user tool; a build pipeline is pure overhead |
| 4 | **Gemini free tier initially**, then paid | Started free to prove the concept. Free tier returned frequent 503s under load → moved to paid Gemini Pro |
| 5 | **Multi-model Council** over single model | Model diversity surfaces disagreement a single model averages away |
| 6 | **Role-based adversarial seats** over "everyone gives a take" | Multi-agent trading literature: coordination structure drives quality more than model count |
| 7 | **Bull and Bear forced onto different models** | One model arguing with itself is theatre |
| 8 | **Catfish framed as mandatory duty**, not "be critical" | Measured ~99% vs ~55% genuine disagreement |
| 9 | **Catfish can force a CFO revision** | A devil's advocate whose objection can be ignored is decoration |
| 10 | **Risk Manager holds veto weight** | A great story with an unmanageable stop is a bad trade |
| 11 | **GPT → Fact-Checker, Gemini → Macro, Claude → reasoning seats** | Matched to each model's benchmark strength |
| 12 | **Rolling model aliases over pinned versions** | `gemini-2.5-flash` was retired for new accounts mid-project and 404'd in production |
| 13 | **Soft budget guard, never auto-degrade** | A system that quietly gets weaker to save money destroys trust in its output |
| 14 | **Supabase free tier** over paid Render disk (~$7/mo) | Consistent with using free external services; Render's free tier has no persistent disk and was wiping all state on every deploy |
| 15 | **Supabase over plain `fetch`**, no SDK | PostgREST is a REST API; the SDK adds weight for nothing |
| 16 | **Hybrid schema** — tables for append-heavy collections, one JSONB row for the rest | Avoids rewriting megabytes of transcripts on a settings change; makes ticker queries real indexed lookups |
| 17 | **Kept the synchronous store API** behind an async facade | Rewriting ~15 route files to async was large risk for zero behavioural gain |
| 18 | **LLM entity extraction replacing regex** | Regex was Latin-only; his alpha channels are Hebrew. The failure was silent |
| 19 | **Never guess a ticker** | A wrong mapping analyses the wrong company — worse than no mapping |
| 20 | **B2 plain-English persona**, scoped to writing only | English is his second language; simplifying the *writing* must not simplify the *analysis* |
| 21 | **Telegram = headline + link; app = full transcript** | Detail belongs where it can be read and questioned |
| 22 | **Unified analysis store** | Only saving trades meant discarding most of the system's thinking and re-litigating names from scratch |
| 23 | **Reflection gated on sample size** | Asserting a pattern from 2 trades would make calibration worse, not better |

---

## 12. Quick orientation for a fresh session

```
server/
  index.js                    Express app, route mounting, startup, health
  lib/
    store.js                  readContext/writeContext/updateContext facade (sync API)
    storage/                  index.js (facade + mutate) + fileAdapter + supabaseAdapter
    appAuth.js                APP_KEY auth middleware (every /api route except ping + webhook)
    cronAuth.js               shared X-Cron-Key check + reportCronFailure
    tickerDetect.js           cashtag + bare-caps regex, stopword list
  services/
    council.js                convene(), chairGenerate(), health, cost metering
    roles.js                  all 8 seat definitions + assignment algorithm
    providers/                index.js registry + gemini/anthropic/openai
    entityExtract.js          Hebrew/multilingual extraction + Stage C parsing
    analysisStore.js          unified analysis history + per-ticker timeline
    reflection.js             learning loop context injection
    journal.js                decision journal + calibration scorecard
    costTracker.js            token pricing, monthly projection, budget guard
    provenance.js             source attribution blocks
    positionReview.js         thesis re-underwriting
    watchdog.js               price mechanics + material event detection
    opportunityHunt.js        candidate sourcing + technical screen
    telegram.js               outbound + webhook registration
    telegramCommands.js       /help /status /ask
    telegramIngest.js         MTProto channel reading
    yahooFinance.js           prices, technicals (DMA/RSI/MACD/Fib)
    marketIndicators.js       the indicator dashboard
    brain.js                  Five Lenses research + chat + SYSTEM_PERSONA
  routes/                     one file per API surface (incl. backup.js — weekly Telegram export)
public/                       8 screens, css/, js/ (one file per screen)
tests/                        node:test suite — `npm test` (journal math, zones, tickers, RSI, extraction filters)
supabase-schema.sql           run once in Supabase SQL Editor
```

**State-mutation rule (important):** never hold a `readContext()` snapshot across an `await` and then `writeContext(snapshot)` — that erases everything written in between (this bug bit the watchdog, position reviews, and the opportunity hunt before 2026-08-25). Do the slow work first, then apply only your own changes inside `updateContext((ctx) => { ... })`.

**To add a 4th AI provider:** write one file in `services/providers/` exporting `{ id, label, isConfigured, generate }` and add it to the array in `providers/index.js`. Nothing else enumerates providers.

**Highest-value next steps:** (1) set `APP_KEY` on Render and add the weekly `/api/backup` cron job, (2) wire `namedPriceLevels` into the watchdog (Stage D — small change, data already extracted), (3) build Marketaux (Stage E) if macro news coverage matters, (4) verify a real Telegram round-trip from the phone (`/status`).

---

## 13. Hardening pass — 2026-08-25

A full code review found and fixed, in one pass (all covered by `npm test` where unit-testable):

**Correctness**
- **Lost-update race, systemic**: routes held a `readContext()` snapshot across long awaits and wrote it back, erasing concurrent writes — event reviews re-fired every tick (paid), recorded analyses vanished until restart, ingest checkpoints rolled back. Fixed with `updateContext()` applied to the live context in every route/service.
- **Journal short math**: `closeEntry` was long-only (literally `? 1 : 1`) — a closed short recorded inverted P&L into the scorecard and calibration. Entries now carry `side`; shorts use action `SHORT`.
- **Deletes never reached Supabase**: deleted signals/journal entries resurrected from Postgres on restart. The adapter now diffs and deletes (analyses excluded on purpose — their in-memory trim is a cap, not a delete).
- **Watchdog event reviews never entered the analysis store** — now they share `persistReview()` with all other review paths.

**Security**
- **`APP_KEY` auth** on every user-facing API route (the portfolio dump, paid research endpoint, brain chat, and deletes were open to anyone with the URL). Cron keys still work everywhere; ping and the Telegram webhook stay exempt. Unset = open, with a loud warning.
- Telegram webhook secret now defaults to `CRON_KEY`; Gemini key moved from URL query to header; dangerous unused `PUT /api/context` (full overwrite, unauthenticated) removed.

**Cost / noise**
- Level-break events get a 7-day per-level cooldown (hovering at the 200 DMA was one paid Council review per tick).
- Convergence alerts dedup: new / newly-strong / resurfaced-after-7-days only (was: every ingest tick for an active name).
- **Every LLM path is now metered** — chat, briefing, weekly review, journal reflection, quick takes, entity extraction were all invisible to the budget guard.
- Ticker fast path is cashtag-only; bare-caps guesses ("NEXT WEEK") no longer enter convergence as high-confidence tickers.
- The three dead settings (hunt candidates, hunt cadence, `fullCouncilPaths`) are enforced.

**Robustness**
- Timeouts on every outbound fetch (providers 300s, data feeds 10–15s, Supabase 20s — a hung socket used to stall the write queue or a Council seat forever).
- Telegram Markdown 400s retry as plain text (an unbalanced `*` in model output used to silently kill the alert).
- Cron failures send one Telegram line (`reportCronFailure`); weekly `/api/backup` exports the context as a JSON document to Telegram; `brain.messages` capped at 500; RSI switched to standard Wilder's smoothing; budget projection no longer cries wolf on day 1 of a month.
- Frontend no longer downloads the entire context (with full transcripts) into localStorage on every page load.

**Honesty**
- "Macro / Live-Web Analyst" renamed **Macro Analyst** — no live search grounding was ever wired in.
- Dead `deliberate()`/`brainstormSignals()` "Analyst A/B/C" path (~200 lines, unmetered) deleted.
