'use strict';

const express = require('express');
const { readContext } = require('../lib/store');
const { listAnalyses, getAnalysis, tickerTimeline } = require('../services/analysisStore');
const costTracker = require('../services/costTracker');

const router = express.Router();

// Browsable, filterable history of every Council debate.
router.get('/', (req, res) => {
  const context = readContext();
  const { ticker, kind, verdict, limit, offset } = req.query;
  res.json(
    listAnalyses(context, {
      ticker,
      kind,
      verdict,
      limit: limit ? Number(limit) : 100,
      offset: offset ? Number(offset) : 0,
    })
  );
});

// Distinct tickers we've analysed, for the filter dropdown.
router.get('/tickers', (req, res) => {
  const context = readContext();
  const counts = new Map();
  for (const a of context.analyses.history || []) {
    for (const t of a.tickers || []) counts.set(t, (counts.get(t) || 0) + 1);
  }
  res.json(
    [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([ticker, count]) => ({ ticker, count }))
  );
});

// How our view of one name evolved over time.
router.get('/timeline/:ticker', (req, res) => {
  const context = readContext();
  res.json(tickerTimeline(context, req.params.ticker));
});

// Permalink target — a single full debate.
router.get('/:id', (req, res) => {
  const context = readContext();
  const analysis = getAnalysis(context, req.params.id);
  if (!analysis) return res.status(404).json({ error: 'analysis not found' });
  res.json(analysis);
});

module.exports = router;
