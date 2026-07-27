'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'context.json');

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
};

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    const now = new Date().toISOString();
    const initial = JSON.parse(JSON.stringify(DEFAULT_CONTEXT));
    initial.meta.createdAt = now;
    initial.meta.updatedAt = now;
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
  }
}

function readContext() {
  ensureFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    // shallow-merge with defaults so new fields introduced later don't crash old files
    return deepMerge(DEFAULT_CONTEXT, parsed);
  } catch (err) {
    console.error('[store] failed to read context.json, returning defaults:', err.message);
    return JSON.parse(JSON.stringify(DEFAULT_CONTEXT));
  }
}

function writeContext(context) {
  ensureFile();
  context.meta = context.meta || {};
  context.meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(context, null, 2));
  return context;
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override !== undefined ? override : base;
  }
  if (typeof base === 'object' && base !== null && typeof override === 'object' && override !== null) {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = deepMerge(base[key], override[key]);
    }
    return out;
  }
  return override !== undefined ? override : base;
}

module.exports = { readContext, writeContext, DATA_FILE };
