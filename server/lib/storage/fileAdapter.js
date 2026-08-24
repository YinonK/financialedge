'use strict';

/**
 * Local JSON file adapter — the original storage, now behind the adapter
 * interface. Used for local development, and as the fallback/safety net when
 * Supabase is unreachable so a write is never lost outright.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'context.json');

function ensureFile(defaultContext) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const now = new Date().toISOString();
    const initial = JSON.parse(JSON.stringify(defaultContext));
    initial.meta.createdAt = now;
    initial.meta.updatedAt = now;
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
  }
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

function read(defaultContext) {
  ensureFile(defaultContext);
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    return deepMerge(defaultContext, parsed);
  } catch (err) {
    console.error('[storage:file] read failed, returning defaults:', err.message);
    return JSON.parse(JSON.stringify(defaultContext));
  }
}

function write(context) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(context, null, 2));
  return context;
}

module.exports = { read, write, DATA_FILE, deepMerge };
