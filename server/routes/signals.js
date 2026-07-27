'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, writeContext } = require('../lib/store');
const { detectTickers } = require('../lib/tickerDetect');

const router = express.Router();

const CONVERGENCE_WINDOW_DAYS = 14;
const CONVERGENCE_MIN_COUNT = 2;
const STRONG_CONVERGENCE_MIN_COUNT = 3;

router.get('/', (req, res) => {
  const context = readContext();
  const items = [...context.signals.items].sort((a, b) => new Date(b.pastedAt) - new Date(a.pastedAt));
  res.json(items);
});

router.post('/', (req, res) => {
  const body = req.body || {};
  if (!body.rawText || !body.rawText.trim()) {
    return res.status(400).json({ error: 'rawText is required' });
  }
  const context = readContext();
  const item = {
    id: crypto.randomUUID(),
    pastedAt: new Date().toISOString(),
    rawText: body.rawText.trim(),
    tickers: detectTickers(body.rawText),
    source: body.source || 'manual paste',
  };
  context.signals.items.push(item);
  writeContext(context);
  res.status(201).json(item);
});

router.delete('/:id', (req, res) => {
  const context = readContext();
  const before = context.signals.items.length;
  context.signals.items = context.signals.items.filter((s) => s.id !== req.params.id);
  if (context.signals.items.length === before) {
    return res.status(404).json({ error: 'signal not found' });
  }
  writeContext(context);
  res.status(204).end();
});

router.get('/convergence/report', (req, res) => {
  const context = readContext();
  const cutoff = Date.now() - CONVERGENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recent = context.signals.items.filter((s) => new Date(s.pastedAt).getTime() >= cutoff);

  const byTicker = new Map();
  for (const item of recent) {
    for (const ticker of item.tickers) {
      if (!byTicker.has(ticker)) byTicker.set(ticker, []);
      byTicker.get(ticker).push({ id: item.id, pastedAt: item.pastedAt, source: item.source });
    }
  }

  const report = [...byTicker.entries()]
    .map(([ticker, mentions]) => ({
      ticker,
      count: mentions.length,
      convergence: mentions.length >= CONVERGENCE_MIN_COUNT,
      strongConvergence: mentions.length >= STRONG_CONVERGENCE_MIN_COUNT,
      mentions,
    }))
    .filter((r) => r.count >= CONVERGENCE_MIN_COUNT)
    .sort((a, b) => b.count - a.count);

  res.json({
    windowDays: CONVERGENCE_WINDOW_DAYS,
    generatedAt: new Date().toISOString(),
    convergences: report,
  });
});

module.exports = router;
