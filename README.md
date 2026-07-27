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

## The AI Council — multi-model negotiation

The Brain can run on one AI provider or several at once. With two or three keys configured (any subset of Gemini / Claude / OpenAI), significant decisions go through **the Council**:

1. **Round 1** — each model independently produces its own Five Lenses take from the same data.
2. **Round 2** — each model sees the others' takes (anonymized as Analyst A/B/C to avoid brand deference) and must rebut or concede, then submit a revised take.
3. **Consensus** — the chair model (`AI_CHAIR` in `.env`, defaults to the first configured) merges the revised takes into one verdict that is *required* to surface real disagreements rather than paper over them. A split council pulls conviction down and usually lands on WATCH — a split is signal, not noise.

The full negotiation convenes on research calls. Lighter one-round "quick takes" from all models get merged into Telegram alerts at significant crossroads: watchdog flags (stop breached/approaching, target hit, market confluence) and fresh signal convergences. Chat and the morning briefing stay single-voice (the chair) to keep them fast.

With one key, everything collapses gracefully to a single-model Brain — no negotiation, no extra cost. Gemini's key is free; Anthropic and OpenAI are pay-per-token (a few dollars a month at this usage). Provider clients live in `server/services/providers/`, orchestration in `server/services/council.js` — adding a fourth provider is one new file.

## The Five Lenses

Every research call runs all five and asks the Council to synthesize them into a Bull case, Bear case, "what kills this trade," a conviction score (1-10), and a verdict (BUY / WATCH / AVOID):

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

- `GEMINI_API_KEY` — **get a free key at https://aistudio.google.com/apikey** and paste it in. Research and Brain Chat return a clear, non-crashing message if no AI key is present — nothing is silently mocked.
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — optional, paid per-token (console.anthropic.com / platform.openai.com). Adding a second/third key turns on Council negotiation (see above). `AI_CHAIR` picks which model is the single voice for chat/briefing/merging.
- `CRON_KEY` — any random string; the shared secret cron-job.org sends to trigger the weekday briefing, the market-hours watchdog, and Telegram channel ingestion (one key, reused across all three).
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — optional; if either is missing, alerts just log to the console instead of sending (see Telegram section below).
- `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_SESSION` / `TELEGRAM_CHANNELS` — optional, only needed for autonomous channel ingestion (see that section below).

```bash
npm start        # or: npm run dev  (auto-restarts on file changes)
```

Open http://localhost:3000.

## Deploying — step by step

### 1. Push to GitHub

Render deploys from a GitHub repo, so this needs to be on GitHub first.

1. Go to https://github.com/new, create a new repository (private is fine, e.g. `financialedge`). Don't initialize it with a README/gitignore — this project already has both.
2. Back in a terminal, in this project folder:
   ```bash
   git remote add origin https://github.com/<your-username>/financialedge.git
   git branch -M main
   git push -u origin main
   ```
3. If prompted for credentials, GitHub no longer accepts your account password for this — you'll need a Personal Access Token (GitHub will show a link to create one) or to have the GitHub CLI (`gh auth login`) set up.

### 2. Deploy to Render.com (free tier)

1. Create a free account at https://render.com (GitHub sign-in is the fastest path, and it's what lets Render see your repos).
2. From the Render dashboard: **New +** → **Blueprint**.
3. Connect your GitHub account if prompted, then select the `financialedge` repo you just pushed.
4. Render reads `render.yaml` automatically and shows the `financialedge` web service it defines. Click **Apply**.
5. Render will ask you to fill in the env vars marked `sync: false` in `render.yaml` — at minimum `GEMINI_API_KEY` and `CRON_KEY`; add the Telegram ones too if you have them ready (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and — once you've run the local Telegram login — `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`, `TELEGRAM_CHANNELS`). You can always add the rest later from **Environment** in the service settings and it'll redeploy.
6. Deploy. First build takes a few minutes; watch the logs in the Render dashboard for the same startup messages you'd see locally (`FinancialEdge server listening...`, and which integrations are/aren't configured).
7. Once live, note the URL Render gives you (`https://financialedge-xxxx.onrender.com`) — that's what goes into the cron-job.org jobs below.

**Free tier caveats:**
- Render's free web services **sleep after 15 minutes of inactivity** and take ~30-60s to wake on the next request. This is why the cron jobs below exist — they're both the trigger for scheduled work and the thing that wakes the service up.
- Free tier does **not** support persistent disks, so `data/context.json` resets on every redeploy/restart. The browser's `localStorage` mirror is what actually survives — it re-syncs to the server on page load. If you want `data/context.json` to survive restarts, upgrade to a paid Render plan and add a `disk:` block to `render.yaml`.

## Setting up the three scheduled jobs (cron-job.org)

Because Render's free tier sleeps, an external cron trigger is required for anything that needs to run on a schedule — a scheduler running *inside* a sleeping service can't wake itself up. All three jobs below use the same `CRON_KEY` secret in an `X-Cron-Key` header.

Create a free account at https://cron-job.org, then set up three separate jobs:

| Job | URL | Method | Schedule |
|---|---|---|---|
| Morning briefing | `https://<your-app>.onrender.com/api/briefing` | POST | weekdays 07:30 Israel time |
| Portfolio watchdog | `https://<your-app>.onrender.com/api/watchdog` | POST | every 30-60 min, weekdays ~16:30-23:00 Israel time (covers 9:30am-4pm ET) |
| Telegram channel ingestion | `https://<your-app>.onrender.com/api/signals/ingest` | POST | every 15-30 min, any time — alpha channels don't only post during market hours |

For each: add a custom header `X-Cron-Key: <the value you put in CRON_KEY>`. cron-job.org lets you pick a timezone directly when scheduling, or convert to UTC yourself (Israel is UTC+2 in winter / UTC+3 during DST).

The watchdog endpoint also double-checks server-side that it's actually US market hours before doing any work (`?force=true` skips that check, useful when testing manually). All three return 401 without a valid key, so don't publish these URLs without the header.

## Telegram — outbound alerts + bidirectional chat

`server/services/telegram.js` sends briefing/watchdog alerts via `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` if both are set; if either is missing, it logs to the console instead — the pipeline still runs end-to-end without a bot configured.

Setup: message **@BotFather** on Telegram, send `/newbot`, follow the prompts — you get a token immediately, no approval wait. For the chat ID: message your new bot anything once, then open `https://api.telegram.org/bot<token>/getUpdates` in a browser and read `"chat":{"id": ...}` from the JSON, or just message **@userinfobot** to get your own numeric ID.

Once both are set, the server automatically registers a webhook at startup (`services/telegram.js`'s `registerWebhook()`) pointing Telegram at `/api/telegram/webhook`, using Render's automatic `RENDER_EXTERNAL_URL`. This makes the bot **bidirectional**:
- **Outbound**: the watchdog and briefing push alerts to your chat when something needs attention (stop approaching/breached, target hit, market confluence, a fresh signal convergence).
- **Inbound**: reply to the bot (or just message it anything) and it feeds straight into The Brain's chat — same portfolio/signals/memory context as the Brain Chat screen, with the reply sent back to you in Telegram. The Brain can also proactively ask you a clarifying question this way, not just answer when you open the app.

Optionally set `TELEGRAM_WEBHOOK_SECRET` (any random string) for an extra layer of validation on inbound requests. Only messages from the exact `TELEGRAM_CHAT_ID` are processed — anything else is logged and ignored.

## Telegram — autonomous channel ingestion

Beyond manual paste, The Brain can read alpha channels Yinon follows and feed detected tickers into the same convergence detector. This needs a different setup than the bot above, because **a plain Bot API token can only read chats it's explicitly added to** — it can't see posts in channels you merely follow. Reading those requires logging in as your own Telegram account via MTProto (the same protocol the official apps use), through the `telegram` (GramJS) package.

Setup (one-time):
1. Get `TELEGRAM_API_ID` + `TELEGRAM_API_HASH` for free at https://my.telegram.org (log in with your phone number → "API development tools" → create an app). Add both to `.env`.
2. Run `npm run telegram:login` — it asks for your phone number, the login code Telegram texts you, and your 2FA password if you have one. At the end it prints a **session string**.
3. Paste that session string into `.env` as `TELEGRAM_SESSION`. Treat it like a password — it's equivalent to being logged into Telegram as you. It's git-ignored, same as every other secret here.
4. Set `TELEGRAM_CHANNELS` to a comma-separated list of channel handles to watch (no `@` needed), e.g. `TELEGRAM_CHANNELS=some_channel,another_channel`.

Each ingestion run (triggered by cron-job.org, see table above) spins up a short-lived session, pulls messages newer than the last-seen checkpoint per channel, runs them through the same ticker-detection regex as manual paste, and stores them with `source: "telegram:@channelname"` — visible on the Signals screen exactly like anything pasted by hand. If a freshly-ingested ticker crosses the convergence threshold, you get a Telegram alert immediately rather than having to check the app.

This is why polling (not a persistent live connection) — Render's free tier freezes the whole process when there's no inbound HTTP traffic, so a long-lived MTProto connection would just die with the dyno. Each cron-triggered run does its work in a few seconds and disconnects, the same "wake, work, sleep" shape as the briefing and watchdog.

## Portfolio watchdog

`server/services/watchdog.js` + `POST /api/watchdog` checks every open position's live price against its stop/target zone. It flags (and Telegram-alerts on) a breached stop, a stop that's getting close, or a target hit — plus a market-wide confluence alert if 2+ indicators are red. **It only observes and alerts; it never places, modifies, or cancels an order, and never touches a stop loss.** That decision is always Yinon's.

## Testing the AI calls

Everything works without `GEMINI_API_KEY` — Research shows raw Five Lenses data with a clear "not configured" note instead of a narrative, and Brain Chat returns an explicit error telling you what to do. Once you add a real key (free, from https://aistudio.google.com/apikey) and restart the server, both come alive with actual Gemini 2.0 Flash output.

## Project layout

```
server/
  index.js              Express app entry point
  routes/               one file per API surface (market, portfolio, research, signals, brain, briefing,
                         watchdog, telegramWebhook, context)
  services/              Yahoo Finance, CNN Fear&Greed, FX, red-day counter, valuation, flow&sentiment,
                          market indicators aggregator, risk/portfolio-fit math, Gemini client,
                          Telegram (outbound + webhook registration), Telegram channel ingestion (GramJS),
                          portfolio watchdog
  lib/                   context.json persistence, ticker-detection regex, shared cron-key auth
scripts/
  telegram-login.js      one-time interactive MTProto login (npm run telegram:login)
public/
  index.html, portfolio.html, research.html, signals.html, brain.html
  css/style.css
  js/                    api.js (fetch wrapper), shared.js (nav, localStorage sync, indicator cards), one file per screen
data/
  context.json           persisted state (git-ignored — this is your data, not code)
```
