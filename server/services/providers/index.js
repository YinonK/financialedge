'use strict';

/**
 * Provider registry.
 *
 * Adding a fourth provider (Grok for native X/Twitter access, DeepSeek,
 * whatever comes next) is deliberately trivial: write one file in this
 * directory exporting { id, label, isConfigured, generate }, then add it to
 * the array below. Nothing else in the codebase enumerates providers — the
 * Council, health reporting, and role assignment all read from here.
 *
 * Every provider takes the same shape:
 *   id           — short stable key used in env vars and role config
 *   label        — human-readable, includes the resolved model name
 *   isConfigured — whether its API key is present
 *   generate(systemInstruction, history, opts) -> Promise<string>
 *
 * Model IDs are always env-overridable and default to rolling aliases where
 * the provider offers one. Version-pinned IDs get retired without warning —
 * we already ate a 404 in production from pinning gemini-2.5-flash.
 */

const geminiProvider = require('./geminiProvider');
const anthropicProvider = require('./anthropicProvider');
const openaiProvider = require('./openaiProvider');

const ALL_PROVIDERS = [geminiProvider, anthropicProvider, openaiProvider];

function all() {
  return ALL_PROVIDERS;
}

function configured() {
  return ALL_PROVIDERS.filter((p) => p.isConfigured());
}

function byId(id) {
  return ALL_PROVIDERS.find((p) => p.id === id) || null;
}

module.exports = { all, configured, byId };
