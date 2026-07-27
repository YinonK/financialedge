'use strict';

const express = require('express');
const { readContext, writeContext } = require('../lib/store');

const router = express.Router();

// Full context read — the browser pulls this on load to hydrate localStorage.
router.get('/', (req, res) => {
  res.json(readContext());
});

// Full context write — the browser pushes its localStorage copy here to
// sync. This is a last-write-wins merge, which is fine for a single-user tool.
router.put('/', (req, res) => {
  const incoming = req.body || {};
  const current = readContext();
  const merged = { ...current, ...incoming, meta: current.meta };
  const saved = writeContext(merged);
  res.json(saved);
});

module.exports = router;
