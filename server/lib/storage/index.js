'use strict';

/**
 * Storage facade.
 *
 * The whole app calls readContext()/writeContext() synchronously, and ~15
 * route files depend on that. Supabase is inherently async. Rewriting every
 * call site to async/await would be a large, risky change for no behavioural
 * gain, so instead:
 *
 *   - the authoritative copy is held in memory
 *   - readContext() serves from memory (instant, consistent)
 *   - writeContext() updates memory immediately, then queues a durable write
 *   - writes are serialised through one queue, so two Council runs finishing
 *     at the same moment cannot interleave and corrupt each other
 *
 * That leaves one honest gap: if the process is killed between an in-memory
 * write and its flush, that write is lost. We keep the window small (flush
 * starts immediately, and SIGTERM triggers a final flush), and this is a
 * single-user tool where the worst case is losing one signal or one analysis
 * that a re-run would recreate. Worth naming rather than pretending it's
 * transactional.
 *
 * Backend selection is automatic: Supabase when configured, otherwise the
 * local JSON file. Local dev needs no Supabase account.
 */

const fileAdapter = require('./fileAdapter');
const supabaseAdapter = require('./supabaseAdapter');

let cache = null; // authoritative in-memory context
let lastPersisted = null; // snapshot used to diff which collection rows are new
let backend = 'file';
let queue = Promise.resolve();
let pendingError = null;

function activeAdapter() {
  return backend === 'supabase' ? supabaseAdapter : fileAdapter;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Loads the context once at startup. If Supabase is configured but empty,
 * seeds it from whatever is in the local file — so an existing deployment's
 * data migrates up on first boot rather than being silently discarded.
 */
async function init(defaultContext) {
  if (supabaseAdapter.isConfigured()) {
    const health = await supabaseAdapter.healthCheck();
    if (health.ok) {
      backend = 'supabase';
      try {
        cache = await supabaseAdapter.read(defaultContext);

        const isEmpty =
          !cache.signals.items.length &&
          !cache.analyses.history.length &&
          !cache.journal.entries.length &&
          !cache.portfolio.positions.length;

        if (isEmpty) {
          const local = fileAdapter.read(defaultContext);
          const localHasData =
            local.signals.items.length ||
            local.analyses.history.length ||
            local.journal.entries.length ||
            local.portfolio.positions.length;
          if (localHasData) {
            console.log('[storage] Supabase is empty and local data exists — migrating local context up.');
            cache = local;
            await supabaseAdapter.write(cache, { signals: { items: [] }, analyses: { history: [] }, journal: { entries: [] } });
          }
        }

        lastPersisted = clone(cache);
        console.log(
          `[storage] Using Supabase. Loaded ${cache.signals.items.length} signals, ${cache.analyses.history.length} analyses, ${cache.journal.entries.length} journal entries.`
        );
        return cache;
      } catch (err) {
        console.error('[storage] Supabase read failed, falling back to local file:', err.message);
        pendingError = err.message;
      }
    } else {
      console.error(
        `[storage] Supabase is configured but unreachable (${health.error}). Falling back to the local file — data will NOT survive redeploys until this is fixed.`
      );
      pendingError = health.error;
    }
  } else {
    console.log(
      '[storage] SUPABASE_URL / SUPABASE_SERVICE_KEY not set — using the local file. On Render free tier this resets on every redeploy.'
    );
  }

  backend = 'file';
  cache = fileAdapter.read(defaultContext);
  lastPersisted = clone(cache);
  return cache;
}

function read(defaultContext) {
  if (!cache) {
    // init() hasn't run (or failed very early) — degrade to a direct file read
    // rather than throwing and taking the request down.
    cache = fileAdapter.read(defaultContext);
    lastPersisted = clone(cache);
  }
  return clone(cache);
}

function write(context) {
  context.meta = context.meta || {};
  context.meta.updatedAt = new Date().toISOString();
  cache = clone(context);

  const snapshot = clone(cache);
  const previous = lastPersisted;

  // Serialise persistence so concurrent writers queue rather than race.
  queue = queue
    .then(async () => {
      if (backend === 'supabase') {
        await supabaseAdapter.write(snapshot, previous);
      } else {
        fileAdapter.write(snapshot);
      }
      lastPersisted = snapshot;
      pendingError = null;
    })
    .catch((err) => {
      pendingError = err.message;
      console.error('[storage] durable write failed:', err.message);
      // Keep the local file as a safety net so nothing is lost outright.
      try {
        fileAdapter.write(snapshot);
      } catch (e) {
        console.error('[storage] local fallback write also failed:', e.message);
      }
    });

  return context;
}

/** Await all queued writes — used on shutdown and by cron routes before responding. */
async function flush() {
  await queue;
  return { ok: !pendingError, error: pendingError };
}

function status() {
  return {
    backend,
    supabaseConfigured: supabaseAdapter.isConfigured(),
    lastError: pendingError,
    counts: cache
      ? {
          signals: cache.signals.items.length,
          analyses: cache.analyses.history.length,
          journalEntries: cache.journal.entries.length,
          positions: cache.portfolio.positions.length,
        }
      : null,
  };
}

module.exports = { init, read, write, flush, status };
