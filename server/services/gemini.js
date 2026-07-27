'use strict';
// Legacy shim — the Gemini client moved to providers/geminiProvider.js when
// The Council (multi-model negotiation) landed. Kept only so any stale
// require() of this path still works.
module.exports = require('./providers/geminiProvider');
