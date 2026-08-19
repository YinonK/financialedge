'use strict';

const express = require('express');
const { readContext, writeContext } = require('../lib/store');
const journal = require('../services/journal');
const council = require('../services/council');
const { SYSTEM_PERSONA } = require('../services/brain');

const router = express.Router();

router.get('/', (req, res) => {
  const context = readContext();
  const entries = [...context.journal.entries].sort((a, b) => new Date(b.ts) - new Date(a.ts));
  res.json(entries);
});

router.get('/scorecard', (req, res) => {
  const context = readContext();
  res.json(journal.scorecard(context.journal.entries));
});

router.post('/', (req, res) => {
  const body = req.body || {};
  if (!body.ticker) return res.status(400).json({ error: 'ticker is required' });

  const context = readContext();
  const entry = journal.createEntry(body);
  context.journal.entries.push(entry);
  writeContext(context);
  res.status(201).json(entry);
});

router.put('/:id', (req, res) => {
  const context = readContext();
  const idx = context.journal.entries.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'journal entry not found' });

  const updatable = ['ticker', 'action', 'shares', 'price', 'stopPrice', 'targetPrice', 'thesis', 'conviction'];
  const body = req.body || {};
  for (const key of updatable) {
    if (body[key] !== undefined) {
      context.journal.entries[idx][key] =
        ['shares', 'price', 'stopPrice', 'targetPrice', 'conviction'].includes(key) && body[key] !== null
          ? Number(body[key])
          : key === 'ticker'
          ? String(body[key]).toUpperCase()
          : body[key];
    }
  }
  writeContext(context);
  res.json(context.journal.entries[idx]);
});

// Reconcile a decision against what actually happened.
router.post('/:id/outcome', (req, res) => {
  const context = readContext();
  const idx = context.journal.entries.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'journal entry not found' });

  context.journal.entries[idx] = journal.closeEntry(context.journal.entries[idx], req.body || {});
  writeContext(context);
  res.json(context.journal.entries[idx]);
});

router.delete('/:id', (req, res) => {
  const context = readContext();
  const before = context.journal.entries.length;
  context.journal.entries = context.journal.entries.filter((e) => e.id !== req.params.id);
  if (context.journal.entries.length === before) {
    return res.status(404).json({ error: 'journal entry not found' });
  }
  writeContext(context);
  res.status(204).end();
});

/**
 * The Brain reflects on its own track record. This is the point of the
 * journal — not record-keeping for its own sake, but feeding realized
 * outcomes back so calibration can actually improve.
 */
router.post('/reflect', async (req, res) => {
  if (!council.anyConfigured()) {
    return res.status(400).json({ error: 'No AI provider configured.' });
  }
  try {
    const context = readContext();
    const entries = context.journal.entries;
    const closed = entries.filter((e) => e.status === 'closed');
    if (!closed.length) {
      return res.json({ reflection: 'No closed decisions yet — nothing to grade. Come back after a few trades round-trip.' });
    }

    const stats = journal.scorecard(entries);
    const prompt = `Here is Yinon's decision track record so far.

Scorecard:
${JSON.stringify(stats, null, 2)}

Closed decisions (with the Council's read at the time, and what actually happened):
${JSON.stringify(
  closed.slice(-25).map((e) => ({
    ticker: e.ticker,
    action: e.action,
    conviction: e.conviction,
    council: e.council,
    thesis: e.thesis,
    outcome: e.outcome,
  })),
  null,
  2
)}

Grade this honestly and specifically. Where is the Council well calibrated, and where is it fooling itself? Does high conviction actually predict better outcomes here, or not? Does a split Council predict worse ones? Call out any pattern in how Yinon's theses fail. Be blunt — vague encouragement is worthless. Under 250 words, no preamble.`;

    const reflection = await council.chairGenerate(SYSTEM_PERSONA, [{ role: 'user', content: prompt }], {
      json: false,
      maxOutputTokens: 2048,
    });

    res.json({ reflection, scorecard: stats });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
