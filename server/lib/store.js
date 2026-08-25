'use strict';

const storage = require('./storage');
const { DATA_FILE } = require('./storage/fileAdapter');

const DEFAULT_CONTEXT = {
  meta: {
    createdAt: null,
    updatedAt: null,
  },
  portfolio: {
    positions: [], // { id, ticker, side, shares, entryPrice, stopPrice, targetPrice, entryDate, notes, thesis }
  },
  signals: {
    items: [], // { id, pastedAt, rawText, tickers: [], source }
    // Convergence alerts already sent, so a name the channels discuss daily
    // doesn't re-trigger a paid Council run on every 15-minute ingest.
    // { [ticker]: { count, strong, lastAlertAt } }
    alertedConvergences: {},
  },
  brain: {
    messages: [], // { id, role, content, ts }
    memory: {}, // freeform key facts the brain has learned about Yinon / open theses
  },
  indicators: {
    thresholds: {
      user: {
        fearGreedBelow: 15,
        vixAbove: 30,
        vixWatchAbove: 20,
        s5fiBelow: 20,
        consecutiveRedDays: 3,
      },
      brain: {
        us10yAbove: 4.5,
        putCallAbove: 1.2,
        dxyAbove: 105,
        aaiiBearsAbove: 50,
      },
    },
  },
  briefing: {
    history: [], // { id, ts, summary }
  },
  watchdog: {
    history: [], // { id, ts, flags: [...], summary }
  },
  journal: {
    // Every decision Yinon makes, with the Council's read at the time, so the
    // Brain can be scored against its own track record later.
    // { id, ts, ticker, action, shares, price, thesis, conviction, council,
    //   positionId, status: 'open'|'closed', outcome: {...} }
    entries: [],
  },
  opportunities: {
    history: [], // { id, ts, candidates: [...], councilRead, delivery }
  },
  review: {
    history: [], // { id, ts, weekOf, summary, delivery }
  },
  entityCache: {
    // Hebrew/other company name -> { ticker, exchange }. Resolved once by the
    // extractor, reused forever, so a recurring company costs nothing after
    // the first sighting.
    mappings: {},
    unmapped: [], // names we recognised as companies but could NOT map — for manual review
  },
  telegramIngest: {
    lastMessageId: {}, // { [channelHandle]: messageId } — checkpoint so we never re-ingest the same message
  },
  positionReviews: {
    history: [], // { positionId, ticker, trigger, verdict, thesisStatus, ... }
    lastReviewedAt: {}, // { [positionId]: ISO } — lets one daily cron serve any cadence
    seenSignalIds: {}, // { [positionId]: [signalId] } — so an event fires once, not every tick
    // A price hovering at its 200 DMA is one event, not one per watchdog tick.
    // { [positionId]: { [levelName]: ISO of last review triggered by it } }
    seenLevelBreaks: {},
  },
  analyses: {
    // Every Council run, whatever triggered it — research, convergence,
    // opportunity hunt, position review. Full transcript, so the Brain can
    // learn from looks that never became trades.
    history: [],
  },
  costs: {
    months: {}, // { 'YYYY-MM': { totalUsd, runs, calls, byProvider } }
    recentRuns: [], // { ts, label, totalUsd, calls, byProvider }
    lastWarnedOn: null, // YYYY-MM-DD — one budget warning per day, max
  },
  settings: {
    // How often open positions get a scheduled Council re-underwriting.
    // 0 disables scheduled reviews (event-triggered ones still fire).
    positionReviewCadenceDays: 3,

    // Soft monthly budget. Nothing is auto-disabled at the ceiling — Yinon
    // gets told and decides.
    budgetCeilingUsd: 30,
    budgetWarnFraction: 0.8,

    // Opportunity hunt
    opportunityHuntCandidates: 3,
    opportunityHuntCadenceDays: 1,

    // Which paths convene the full role-based Council. All default true —
    // depth is the point; these exist so Yinon can dial back if he wants,
    // not so the system quietly saves money.
    fullCouncilPaths: {
      research: true,
      opportunityHunt: true,
      convergence: true,
      positionReview: true,
    },

    // Per-provider or per-model $/1M-token overrides, e.g. { "anthropic": { "input": 2, "output": 10 } }.
    // Lets Yinon correct pricing from the invoice without a code change.
    pricingOverrides: {},
  },
};


/**
 * Public store API — unchanged on purpose.
 *
 * Every route calls readContext()/writeContext() synchronously. Those now sit
 * on top of the storage facade, which keeps the authoritative copy in memory
 * and persists asynchronously to Supabase (or the local file when Supabase
 * isn't configured). Nothing downstream had to change.
 */

async function initStore() {
  return storage.init(DEFAULT_CONTEXT);
}

function readContext() {
  return storage.read(DEFAULT_CONTEXT);
}

function writeContext(context) {
  capUnbounded(context);
  return storage.write(context);
}

/**
 * The safe way to change state: do slow work FIRST, then apply only your own
 * changes to the live context inside `fn`. Holding a readContext() snapshot
 * across an `await` and writing it back erases everything written in between —
 * that bug bit the watchdog, position reviews, and the opportunity hunt.
 */
function updateContext(fn) {
  return storage.mutate((context) => {
    const result = fn(context);
    const out = result === undefined ? context : result;
    capUnbounded(out);
    return out;
  }, DEFAULT_CONTEXT);
}

// brain.messages was the one collection with no cap — every chat grew the
// app_state blob forever. The LLM only ever reads the last 20 anyway.
const MAX_BRAIN_MESSAGES = 500;
function capUnbounded(context) {
  const msgs = context.brain && context.brain.messages;
  if (Array.isArray(msgs) && msgs.length > MAX_BRAIN_MESSAGES) {
    context.brain.messages = msgs.slice(-MAX_BRAIN_MESSAGES);
  }
}

/** Await pending durable writes — used by cron routes and on shutdown. */
function flushStore() {
  return storage.flush();
}

function storageStatus() {
  return storage.status();
}

module.exports = { readContext, writeContext, updateContext, initStore, flushStore, storageStatus, DATA_FILE, DEFAULT_CONTEXT };
