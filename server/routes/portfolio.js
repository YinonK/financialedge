'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, writeContext, updateContext } = require('../lib/store');
const { getQuote } = require('../services/yahooFinance');
const { getUsdIls } = require('../services/fx');
const { computeZone } = require('../services/riskPortfolio');
const journalService = require('../services/journal');

const router = express.Router();

const MAX_POSITIONS = 5;

router.get('/', async (req, res) => {
  try {
    const context = readContext();
    const positions = context.portfolio.positions;

    const [quotes, fx] = await Promise.all([
      Promise.allSettled(positions.map((p) => getQuote(p.ticker))),
      safeFx(),
    ]);

    const enriched = positions.map((p, i) => {
      const q = quotes[i];
      if (q.status !== 'fulfilled') {
        return { ...p, live: { error: q.reason ? q.reason.message : 'quote unavailable' } };
      }
      const currentPrice = q.value.price;
      const directionMult = p.side === 'short' ? -1 : 1;
      const pnlUsd = (currentPrice - p.entryPrice) * p.shares * directionMult;
      const costBasis = p.entryPrice * p.shares;
      const pnlPct = costBasis ? (pnlUsd / Math.abs(costBasis)) * 100 : null;
      const pnlIls = fx.rate ? pnlUsd * fx.rate : null;

      const zone = computeZone(p, currentPrice);

      return {
        ...p,
        live: {
          currentPrice,
          asOf: q.value.asOf,
          pnlUsd: +pnlUsd.toFixed(2),
          pnlPct: pnlPct != null ? +pnlPct.toFixed(2) : null,
          pnlIls: pnlIls != null ? +pnlIls.toFixed(2) : null,
          zone,
        },
      };
    });

    const totalPnlUsd = enriched.reduce((sum, p) => sum + (p.live && p.live.pnlUsd ? p.live.pnlUsd : 0), 0);

    res.json({
      positions: enriched,
      count: positions.length,
      maxPositions: MAX_POSITIONS,
      atCapacity: positions.length >= MAX_POSITIONS,
      totalPnlUsd: +totalPnlUsd.toFixed(2),
      totalPnlIls: fx.rate ? +(totalPnlUsd * fx.rate).toFixed(2) : null,
      fx,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  if (readContext().portfolio.positions.length >= MAX_POSITIONS) {
    return res.status(400).json({
      error: `Already at the ${MAX_POSITIONS}-position cap. This is a deliberate discipline constraint — close or replace a position first.`,
    });
  }
  const body = req.body || {};
  if (!body.ticker || !body.shares || !body.entryPrice) {
    return res.status(400).json({ error: 'ticker, shares, and entryPrice are required' });
  }
  const position = {
    id: crypto.randomUUID(),
    ticker: String(body.ticker).toUpperCase(),
    side: body.side === 'short' ? 'short' : 'long',
    shares: Number(body.shares),
    entryPrice: Number(body.entryPrice),
    stopPrice: body.stopPrice != null ? Number(body.stopPrice) : null,
    targetPrice: body.targetPrice != null ? Number(body.targetPrice) : null,
    entryDate: body.entryDate || new Date().toISOString().slice(0, 10),
    thesis: body.thesis || '',
    notes: body.notes || '',
  };
  // Auto-log the decision so the journal reflects reality without depending
  // on Yinon remembering to write it down. `council` can be passed in from
  // the Research screen to freeze the Council's read at decision time.
  const entry = journalService.createEntry({
    ticker: position.ticker,
    action: position.side === 'short' ? 'SHORT' : 'BUY',
    side: position.side,
    shares: position.shares,
    price: position.entryPrice,
    stopPrice: position.stopPrice,
    targetPrice: position.targetPrice,
    thesis: position.thesis,
    conviction: body.conviction != null ? body.conviction : null,
    council: body.council || null,
    positionId: position.id,
    source: 'portfolio_open',
  });

  updateContext((context) => {
    context.portfolio.positions.push(position);
    context.journal.entries.push(entry);
  });
  res.status(201).json({ ...position, journalEntryId: entry.id });
});

router.put('/:id', (req, res) => {
  let updated = null;
  updateContext((context) => {
    const idx = context.portfolio.positions.findIndex((p) => p.id === req.params.id);
    if (idx === -1) return;

    const updatable = ['ticker', 'side', 'shares', 'entryPrice', 'stopPrice', 'targetPrice', 'entryDate', 'thesis', 'notes'];
    const body = req.body || {};
    for (const key of updatable) {
      if (body[key] !== undefined) {
        context.portfolio.positions[idx][key] =
          ['shares', 'entryPrice', 'stopPrice', 'targetPrice'].includes(key) && body[key] !== null
            ? Number(body[key])
            : key === 'ticker'
            ? String(body[key]).toUpperCase()
            : body[key];
      }
    }
    updated = context.portfolio.positions[idx];
  });
  if (!updated) return res.status(404).json({ error: 'position not found' });
  res.json(updated);
});

router.delete('/:id', async (req, res) => {
  const position = readContext().portfolio.positions.find((p) => p.id === req.params.id);
  if (!position) {
    return res.status(404).json({ error: 'position not found' });
  }

  // Do the slow part (quote fetch) BEFORE touching state, so the await can't
  // sit between a read and a write and clobber concurrent changes.
  let exitPrice = req.query.exitPrice != null ? Number(req.query.exitPrice) : null;
  if (exitPrice == null) {
    try {
      const q = await getQuote(position.ticker);
      exitPrice = q.price;
    } catch (err) {
      exitPrice = null;
    }
  }

  updateContext((context) => {
    context.portfolio.positions = context.portfolio.positions.filter((p) => p.id !== req.params.id);

    // Closing a position reconciles its journal entry. Exit price comes from
    // the caller if supplied, otherwise the last live quote — never invented.
    const idx = context.journal.entries.findIndex(
      (e) => e.positionId === position.id && e.status === 'open'
    );
    if (idx !== -1) {
      context.journal.entries[idx] = journalService.closeEntry(context.journal.entries[idx], {
        exitPrice,
        shares: position.shares,
        whatHappened: req.query.note || '',
      });
    }
  });
  res.status(204).end();
});

async function safeFx() {
  try {
    return await getUsdIls();
  } catch (err) {
    return { rate: null, date: null, error: err.message };
  }
}

module.exports = router;
