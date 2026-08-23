'use strict';

const express = require('express');
const { readContext, writeContext } = require('../lib/store');

const router = express.Router();

router.get('/', (req, res) => {
  const context = readContext();
  res.json(context.settings);
});

router.put('/', (req, res) => {
  const body = req.body || {};
  const context = readContext();

  if (body.positionReviewCadenceDays !== undefined) {
    const n = Number(body.positionReviewCadenceDays);
    if (!Number.isFinite(n) || n < 0 || n > 90) {
      return res.status(400).json({ error: 'positionReviewCadenceDays must be a number between 0 and 90 (0 disables scheduled reviews)' });
    }
    context.settings.positionReviewCadenceDays = n;
  }

  writeContext(context);
  res.json(context.settings);
});

module.exports = router;
