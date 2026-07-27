# FinancialEdge

A personal investment intelligence platform for Yinon: Israeli investor, US equities, bold/high-risk, macro-first, a concentrated book of ~5 positions max, weeks-to-months holding periods, P&L tracked in USD and ILS.

The server-side AI agent is called **The Brain**. It observes, analyzes, and alerts. It never trades.

## Hard constraint — read this first

**The Brain never executes a trade, places/modifies/cancels an order, or auto-triggers a stop loss. Not once, not ever, not even as a "safety" feature.** Every route and service in this codebase is read-only with respect to any broker or exchange. Yinon pulls every trigger himself. If you extend this project, preserve that boundary — it's the whole point of the design.

The Gemini API key is also server-side only, read from `.env` via `process.env.GEMINI_API_KEY`, and never appears in any response body or frontend code path. An earlier version of this project leaked that key to the browser twice — treat keeping it server-side as non-negotiable.

## Stack

- Node.js 18+ (built-in `fetch`, no HTTP client dependency), Express 4
- Vanilla JS frontend, no build step, no framework — plain `<script>` tags
- Persistence: `data/context.json` on the server, mirrored to the browser's `localStorage` (no database)
- Free data sources only (see below)

## The five screens

1. **Home** — Brain's morning briefing, portfolio snapshot, live market indicators dashboard with confluence alerts.
2. **Portfolio** — CRUD for up to 5 positions, live P&L in USD + ILS, a stop/target zone bar per position.
3. **Research** — Five Lenses deep-dive on any ticker, returned as structured JSON and rendered in the UI.
4. **Signals** — paste anything (tweets, articles, chat messages); tickers are auto-detected and a convergence detector flags names getting 2+ mentions in the last 14 days.
5. **Brain Chat** — full context (portfolio, signals, market state, accumulated memory) in every message.

## The Five Lenses

Every research call runs all five and asks Gemini to synthesize them into a Bull case, Bear case, "what kills this trade," a conviction score (1-10), and a verdict (BUY / WATCH / AVOID):

1. **Valuation** — P/E, PEG, EV/EBITDA, FCF yield (Yahoo Finance `quoteSummary`)
2. **Technical structure** — 50/200 DMA, Fibonacci retracements/extensions, RSI, MACD (+ divergence heuristic), volume trend (Yahoo Finance chart API, computed server-side)
3. **Macro & geopolitics** — the market indicators dashboard (below) plus Gemini's own read
4. **Flow & sentiment** — analyst recommendation trend, short interest, insider buy/sell activity (Yahoo Finance `quoteSummary`)
5. **Risk & portfolio fit** — position sizing off stop distance capped at 2% account risk, correlation check against your current book

Where a lens's data isn't available (Yahoo blocked the request, or a metric has no free feed), it's marked `available: false` / `status: 'na'` with a manual-check hint. **Numbers are never fabricated to fill a gap** — The Brain is told explicitly to reason around missing data rather than invent it.

## Market indicators dashboard

Blue-bordered tiles are *your* thresholds; gold-bordered tiles are *The Brain's* macro thresholds. Every tile has a "?" button with an explainer (what it is, how to read it, why it matters to you, a historical example). A confluence alert fires at 2+ tiles flashing red.

| Indicator | Border | Threshold | Live feed |
|---|---|---|---|
| Fear & Greed Index | blue | < 15 | CNN dataviz endpoint |
| VIX | blue | > 30 (watch > 20) | Yahoo Finance (`^VIX`) |
| Consecutive red days (S&P 500) | blue | ≥ 3 | computed server-side from Yahoo closes |
| S5FI | blue | < 20 | **no free feed — shown as N/A with manual-check instructions** |
| US 10-Year yield | gold | > 4.5% | Yahoo Finance (`^TNX`) |
| Put/Call ratio | gold | > 1.2 | **no free feed — N/A, check cboe.com manually** |
| DXY | gold | > 105 | Yahoo Finance (`DX-Y.NYB`) |
| Advance/Decline divergence | gold | — | **no free feed — N/A, check stockcharts.com ($NYAD) manually** |
| AAII bears % | gold | > 50% | **no free feed — N/A, published weekly at aaii.com** |
| Gold spike | gold | > 2% daily move | Yahoo Finance (`GC=F`) |
| WTI move | gold | > 3% daily move | Yahoo Finance (`CL=F`) |

The three N/A indicators are intentionally never estimated — they show a manual-check hint instead.

## Data sources (all free)

- **Gemini 2.0 Flash** — server-side only, `.env`-gated, git-ignored
- **Yahoo Finance unofficial chart API** — indices (`^GSPC`, `^VIX`, `^TNX`, `DX-Y.NYB`, `GC=F`, `CL=F`) and arbitrary tickers. Yahoo has tightened bot protection over time; `server/services/yahooFinance.js` retries with a crumb/cookie if the plain request comes back empty, and callers always degrade to a clear error rather than fake data if both attempts fail.
- **CNN Fear & Greed dataviz endpoint** — `production.dataviz.cnn.io/index/fearandgreed/graphdata`
- **frankfurter.app** — USD/ILS FX (note: it redirects to `frankfurter.dev/v1`, which `fetch()` follows automatically)
- **Red-day counter** — computed server-side from raw S&P 500 closes, never trusted from a third party

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- `GEMINI_API_KEY` — **get a free key at https://aistudio.google.com/apikey** and paste it in. Research and Brain Chat both check for this and return a clear, non-crashing message telling you to add it if it's missing — nothing is silently mocked.
- `BRIEFING_KEY` — any random string; this is the shared secret cron-job.org sends to trigger the weekday briefing.
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — optional; if either is missing, briefing delivery just logs to the console instead of sending (see Telegram section below).

```bash
npm start        # or: npm run dev  (auto-restarts on file changes)
```

Open http://localhost:3000.

## Deploying to Render.com (free tier)

`render.yaml` is included — Render will pick it up automatically if you create a new "Blueprint" service from this repo. It sets `runtime: node`, `plan: free`, `buildCommand: npm install`, `startCommand: npm start`, and declares the env vars above as secrets you fill in from the Render dashboard (they're marked `sync: false` so they're not committed).

**Free tier caveats:**
- Render's free web services **sleep after 15 minutes of inactivity** and take ~30-60s to wake on the next request. This is why the cron job below exists — it's both the trigger for your morning briefing and the thing that wakes the service up.
- Free tier does **not** support persistent disks, so `data/context.json` resets on every redeploy/restart. The browser's `localStorage` mirror is what actually survives — it re-syncs to the server on page load. If you want `data/context.json` to survive restarts, upgrade to a paid Render plan and add a `disk:` block to `render.yaml`.

## Setting up the weekday morning briefing (cron-job.org)

Because Render's free tier sleeps, an external cron trigger is required — a scheduler running *inside* a sleeping service can't wake itself up.

1. Create a free account at https://cron-job.org
2. New cron job → URL: `https://<your-render-app>.onrender.com/api/briefing`
3. Method: `POST`
4. Add a custom header: `X-Briefing-Key: <the same value you put in BRIEFING_KEY>`
5. Schedule: weekdays (Mon–Fri) at 07:30 **Israel time** — cron-job.org lets you pick a timezone directly, or convert to UTC yourself (Israel is UTC+2 in winter / UTC+3 during DST)
6. Save. The first run will wake the service and may take up to a minute — that's expected on free tier.

The endpoint checks `X-Briefing-Key` against `BRIEFING_KEY` in `.env` and returns 401 if it doesn't match, so don't publish that URL without the header.

## Telegram delivery

`server/services/telegram.js` sends the briefing via `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` if both are set. If either is missing, it logs the briefing text to the console instead — this is a deliberate stub so the pipeline runs end-to-end without a bot configured. To wire up a real bot: message @BotFather on Telegram to create a bot and get a token, then message @userinfobot (or check `https://api.telegram.org/bot<token>/getUpdates` after messaging your bot once) to get your chat ID.

**Out of scope for this phase** (explicitly deferred, per the original spec): Telegram auto-sync for *ingesting* signals, the position-vs-stop watchdog, daily opportunity hunts, a decision journal, and weekly reviews. This build is the 5 screens + Five Lenses working end-to-end on real data, plus outbound Telegram delivery only.

## Testing the AI calls

Everything works without `GEMINI_API_KEY` — Research shows raw Five Lenses data with a clear "not configured" note instead of a narrative, and Brain Chat returns an explicit error telling you what to do. Once you add a real key (free, from https://aistudio.google.com/apikey) and restart the server, both come alive with actual Gemini 2.0 Flash output.

## Project layout

```
server/
  index.js              Express app entry point
  routes/               one file per API surface (market, portfolio, research, signals, brain, briefing, context)
  services/              Yahoo Finance, CNN Fear&Greed, FX, red-day counter, valuation, flow&sentiment,
                          market indicators aggregator, risk/portfolio-fit math, Gemini client, Telegram
  lib/                   context.json persistence, ticker-detection regex
public/
  index.html, portfolio.html, research.html, signals.html, brain.html
  css/style.css
  js/                    api.js (fetch wrapper), shared.js (nav, localStorage sync, indicator cards), one file per screen
data/
  context.json           persisted state (git-ignored — this is your data, not code)
```
