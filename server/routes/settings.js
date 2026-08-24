'use strict';

const express = require('express');
const { readContext, writeContext } = require('../lib/store');
const costTracker = require('../services/costTracker');

const router = express.Router();

router.get('/', (req, res) => {
  const context = readContext();
  res.json(context.settings);
});

// Spend summary — what's been used this month and where it's heading.
router.get('/costs', (req, res) => {
  const context = readContext();
  const projection = costTracker.projectMonth(context);
  res.json({
    ...projection,
    recentRuns: [...(context.costs.recentRuns || [])].reverse().slice(0, 25),
    defaultPricing: costTracker.DEFAULT_PRICING,
    pricingOverrides: context.settings.pricingOverrides || {},
  });
});

const NUMERIC_FIELDS = {
  positionReviewCadenceDays: { min: 0, max: 90 },
  budgetCeilingUsd: { min: 0, max: 10000 },
  budgetWarnFraction: { min: 0.1, max: 1 },
  opportunityHuntCandidates: { min: 1, max: 10 },
  opportunityHuntCadenceDays: { min: 0, max: 30 },
};

router.put('/', (req, res) => {
  const body = req.body || {};
  const context = readContext();
  const errors = [];

  for (const [field, range] of Object.entries(NUMERIC_FIELDS)) {
    if (body[field] === undefined) continue;
    const n = Number(body[field]);
    if (!Number.isFinite(n) || n < range.min || n > range.max) {
      errors.push(`${field} must be a number between ${range.min} and ${range.max}`);
      continue;
    }
    context.settings[field] = n;
  }

  if (body.fullCouncilPaths && typeof body.fullCouncilPaths === 'object') {
    for (const key of Object.keys(context.settings.fullCouncilPaths)) {
      if (body.fullCouncilPaths[key] !== undefined) {
        context.settings.fullCouncilPaths[key] = Boolean(body.fullCouncilPaths[key]);
      }
    }
  }

  if (body.pricingOverrides && typeof body.pricingOverrides === 'object') {
    const clean = {};
    for (const [key, val] of Object.entries(body.pricingOverrides)) {
      if (!val || typeof val !== 'object') continue;
      const input = Number(val.input);
      const output = Number(val.output);
      if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
        errors.push(`pricingOverrides.${key} needs numeric input and output rates`);
        continue;
      }
      clean[key] = { input, output };
    }
    context.settings.pricingOverrides = clean;
  }

  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  writeContext(context);
  res.json(context.settings);
});

// Reset the running spend for the current month (e.g. after correcting rates).
router.post('/costs/reset', (req, res) => {
  const context = readContext();
  const key = costTracker.monthKey();
  if (context.costs.months[key]) context.costs.months[key] = { totalUsd: 0, runs: 0, calls: 0, byProvider: {} };
  context.costs.lastWarnedOn = null;
  writeContext(context);
  res.json({ reset: key, costs: context.costs.months[key] });
});

module.exports = router;
