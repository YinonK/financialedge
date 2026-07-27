'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, writeContext } = require('../lib/store');
const { checkPositions, isUsMarketHours } = require('../services/watchdog');
const { getIndicators } = require('../services/marketIndicators');
const { sendMessage } = require('../services/telegram');
const { requireCronKey } = require('../lib/cronAuth');

const router = express.Router();

// Triggered by cron-job.org every 30-60 min during US market hours. READ-ONLY:
// this only observes positions and market state and alerts Yinon — it never
// places, modifies, or cancels an order, and never touches a stop loss.
router.post('/', async (req, res) => {
  if (!requireCronKey(req, res)) return;

  const force = req.query.force === 'true';
  if (!force && !isUsMarketHours()) {
    return res.json({ skipped: true, reason: 'outside US market hours (pass ?force=true to override for testing)' });
  }

  try {
    const context = readContext();
    const positions = context.portfolio.positions;

    const [positionFlags, indicators] = await Promise.all([
      checkPositions(positions),
      safeIndicators(context.indicators.thresholds),
    ]);

    const flags = [...positionFlags];

    if (indicators && indicators.confluenceAlert) {
      flags.push({
        ticker: null,
        severity: 'warning',
        message: `Market confluence alert: ${indicators.redCount} indicators are flashing red at once (${indicators.indicators
          .filter((i) => i.status === 'red')
          .map((i) => i.label)
          .join(', ')}).`,
      });
    }

    const actionable = flags.filter((f) => f.severity === 'critical' || f.severity === 'warning' || f.severity === 'good');

    let delivery = null;
    if (actionable.length) {
      const text = `FinancialEdge Watchdog — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\n\n${actionable
        .map((f) => `• ${f.message}`)
        .join('\n')}`;
      delivery = await sendMessage(text);
    }

    const entry = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      flags,
      delivery,
    };
    context.watchdog.history.push(entry);
    if (context.watchdog.history.length > 200) context.watchdog.history.shift();
    writeContext(context);

    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history', (req, res) => {
  const context = readContext();
  res.json(context.watchdog.history);
});

async function safeIndicators(thresholds) {
  try {
    return await getIndicators(thresholds);
  } catch (err) {
    return null;
  }
}

module.exports = router;
