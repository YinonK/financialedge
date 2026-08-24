'use strict';

const express = require('express');
const { readContext } = require('../lib/store');
const { researchTicker } = require('../services/brain');
const { recordAnalysis } = require('../services/analysisStore');

const router = express.Router();

router.get('/:ticker', async (req, res) => {
  try {
    const context = readContext();
    const portfolioTickers = context.portfolio.positions.map((p) => p.ticker);
    const result = await researchTicker(req.params.ticker.toUpperCase(), {
      portfolioTickers,
      indicatorThresholds: context.indicators.thresholds,
      // Passed so the Council can be reminded what we said about this name
      // before and how it actually played out.
      context,
    });
    // Persist the debate so it feeds future reflection and is browsable later.
    if (result.council && result.council.seats && result.council.seats.length) {
      const rec = recordAnalysis({
        ticker: result.ticker,
        kind: 'research',
        trigger: 'manual',
        verdict: result.brainAnalysis,
        seats: result.council.seats,
        catfish: result.council.catfish,
        revisedAfterCatfish: result.council.revisedAfterCatfish,
        missingSeats: result.council.missingSeats,
        providersUsed: result.council.providersUsed,
        errors: result.council.errors,
        cost: result.council.cost,
      });
      if (rec) result.analysisId = rec.id;
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
