'use strict';

const express = require('express');
const { readContext } = require('../lib/store');
const { researchTicker } = require('../services/brain');

const router = express.Router();

router.get('/:ticker', async (req, res) => {
  try {
    const context = readContext();
    const portfolioTickers = context.portfolio.positions.map((p) => p.ticker);
    const result = await researchTicker(req.params.ticker.toUpperCase(), {
      portfolioTickers,
      indicatorThresholds: context.indicators.thresholds,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
