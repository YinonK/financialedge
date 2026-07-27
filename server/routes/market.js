'use strict';

const express = require('express');
const { getIndicators } = require('../services/marketIndicators');
const { getQuote, getSeries } = require('../services/yahooFinance');
const { getUsdIls } = require('../services/fx');
const { readContext } = require('../lib/store');

const router = express.Router();

router.get('/indicators', async (req, res) => {
  try {
    const context = readContext();
    const data = await getIndicators(context.indicators.thresholds);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/quote/:symbol', async (req, res) => {
  try {
    const data = await getQuote(req.params.symbol);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/series/:symbol', async (req, res) => {
  try {
    const { range = '1y', interval = '1d' } = req.query;
    const data = await getSeries(req.params.symbol, { range, interval });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/fx', async (req, res) => {
  try {
    const data = await getUsdIls();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
