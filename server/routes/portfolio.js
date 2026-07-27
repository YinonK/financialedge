'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, writeContext } = require('../lib/store');
const { getQuote } = require('../services/yahooFinance');
const { getUsdIls } = require('../services/fx');

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
  const context = readContext();
  if (context.portfolio.positions.length >= MAX_POSITIONS) {
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
  context.portfolio.positions.push(position);
  writeContext(context);
  res.status(201).json(position);
});

router.put('/:id', (req, res) => {
  const context = readContext();
  const idx = context.portfolio.positions.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'position not found' });

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
  writeContext(context);
  res.json(context.portfolio.positions[idx]);
});

router.delete('/:id', (req, res) => {
  const context = readContext();
  const before = context.portfolio.positions.length;
  context.portfolio.positions = context.portfolio.positions.filter((p) => p.id !== req.params.id);
  if (context.portfolio.positions.length === before) {
    return res.status(404).json({ error: 'position not found' });
  }
  writeContext(context);
  res.status(204).end();
});

function computeZone(position, currentPrice) {
  const { stopPrice, targetPrice, side } = position;
  if (stopPrice == null || targetPrice == null) return null;

  const isLong = side !== 'short';
  const low = isLong ? stopPrice : targetPrice;
  const high = isLong ? targetPrice : stopPrice;
  const range = high - low;
  if (!range) return null;

  const pct = ((currentPrice - low) / range) * 100;
  const clamped = Math.max(-20, Math.min(120, pct));

  return {
    pctToTarget: +clamped.toFixed(1),
    stopPrice,
    targetPrice,
    breachedStop: isLong ? currentPrice <= stopPrice : currentPrice >= stopPrice,
    hitTarget: isLong ? currentPrice >= targetPrice : currentPrice <= targetPrice,
  };
}

async function safeFx() {
  try {
    return await getUsdIls();
  } catch (err) {
    return { rate: null, date: null, error: err.message };
  }
}

module.exports = router;
