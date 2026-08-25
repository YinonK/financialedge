'use strict';

const express = require('express');
const { readContext } = require('../lib/store');
const { requireCronKey } = require('../lib/cronAuth');
const { runCronJob } = require('../lib/asyncCron');
const { sendDocument } = require('../services/telegram');

const router = express.Router();

/**
 * Safety-net export. Supabase's free tier has no point-in-time recovery, and
 * the learning loop's value is exactly its accumulated history — so a weekly
 * cron POST here sends the full working context as a JSON file to Yinon's
 * Telegram chat, where it sits recoverable forever.
 *
 * Scope note, stated honestly: this exports the in-memory working set. For
 * analyses that means the newest ~400 (the table itself may hold more).
 * Signals and journal are complete up to their hydration caps.
 */
router.post('/', async (req, res) => {
  if (!requireCronKey(req, res)) return;

  // Fast today, but the upload grows with the archive — don't let it become
  // another silent timeout as history accumulates.
  return runCronJob('backup export', req, res, async () => {
    const context = readContext();
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `financialedge-backup-${stamp}.json`;
    const body = JSON.stringify(context);

    const delivery = await sendDocument(filename, body, `FinancialEdge backup — ${stamp}`).catch((err) => ({
      delivered: false,
      error: err.message,
    }));

    return {
      ok: true,
      filename,
      bytes: Buffer.byteLength(body),
      counts: {
        signals: context.signals.items.length,
        analyses: context.analyses.history.length,
        journalEntries: context.journal.entries.length,
        positions: context.portfolio.positions.length,
      },
      delivery,
    };
  });
});

module.exports = router;
