'use strict';

const express = require('express');
const { readContext } = require('../lib/store');
const { requireCronKey } = require('../lib/cronAuth');
const { runCronJob } = require('../lib/asyncCron');
const { reviewPosition, positionsDueForReview, persistReview } = require('../services/positionReview');
const { sendMessage } = require('../services/telegram');
const costTracker = require('../services/costTracker');

const router = express.Router();

// A full Council review is ~8 model calls. Reviewing a whole book in one cron
// tick would blow past any sane timeout, so scheduled runs are capped and the
// rest simply come due on the next tick.
const MAX_SCHEDULED_PER_RUN = 2;

function appBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
}

function statusEmoji(status) {
  return status === 'BROKEN' ? '🔴' : status === 'WEAKENING' ? '🟠' : status === 'INTACT' ? '🟢' : '⚪';
}

/**
 * Telegram gets the headline and the decision-relevant line only; the full
 * debate transcript lives in the app where it can actually be read and
 * questioned.
 */
function formatAlert(review) {
  const v = review.verdict || {};
  const base = appBaseUrl();
  const link = base
    ? review.analysisId
      ? `\n\nFull Council debate: ${base}/analyses.html?id=${review.analysisId}`
      : `\n\nFull Council debate: ${base}/analyses.html`
    : '';
  const changed = v.whatChangedSinceEntry ? `\nWhat changed: ${v.whatChangedSinceEntry}` : '';
  const revised = review.revisedAfterCatfish ? '\n(verdict revised after the Catfish challenged it)' : '';

  return `${statusEmoji(v.thesisStatus)} Position Review — ${review.ticker}

Thesis: ${v.thesisStatus || 'unknown'} · Verdict: ${v.verdict || '—'} · Conviction ${
    v.conviction != null ? v.conviction + '/10' : '—'
  }
${v.headline || ''}${changed}

${v.keyTakeaway || ''}${revised}${link}`;
}

// --- Manual review of a single position (from the Portfolio screen) ---
router.post('/:id/review', async (req, res) => {
  try {
    const context = readContext();
    const position = context.portfolio.positions.find((p) => p.id === req.params.id);
    if (!position) return res.status(404).json({ error: 'position not found' });

    const review = await reviewPosition(position, context, { trigger: 'manual' });
    persistReview(review);

    // Alert on manual runs too, but only when the thesis is actually in trouble.
    const status = review.verdict && review.verdict.thesisStatus;
    if (status === 'BROKEN' || status === 'WEAKENING') {
      await sendMessage(formatAlert(review)).catch((err) =>
        console.error('[positions] alert send failed:', err.message)
      );
    }

    res.json(review);
  } catch (err) {
    res.status(err.code === 'NOT_CONFIGURED' ? 400 : 500).json({ error: err.message });
  }
});

// --- Scheduled sweep: reviews whatever is due under the configured cadence ---
// Safe to run daily regardless of cadence — each position self-checks whether
// enough days have passed, so changing the cadence in the app needs no
// cron-job.org change.
router.post('/review-due', async (req, res) => {
  if (!requireCronKey(req, res)) return;

  // Cheap guards first, so "nothing due" still answers definitively.
  const context = readContext();
  const { cadenceDays, due } = positionsDueForReview(context);

  if (!cadenceDays || cadenceDays <= 0) {
    return res.json({ skipped: true, reason: 'scheduled position reviews are disabled (cadence set to 0)' });
  }
  if (!due.length) {
    return res.json({ reviewed: 0, cadenceDays, note: 'nothing due yet' });
  }

  // Up to 2 full Council reviews — several minutes. Acknowledge now.
  return runCronJob('position review sweep', req, res, async () => {
    const batch = due.slice(0, MAX_SCHEDULED_PER_RUN);
    const results = [];

    for (const position of batch) {
      try {
        const review = await reviewPosition(position, readContext(), { trigger: 'scheduled' });
        persistReview(review);

        const status = review.verdict && review.verdict.thesisStatus;
        if (status === 'BROKEN' || status === 'WEAKENING') {
          await sendMessage(formatAlert(review)).catch((err) =>
            console.error('[positions] alert send failed:', err.message)
          );
        }
        results.push({ ticker: position.ticker, thesisStatus: status, verdict: review.verdict && review.verdict.verdict });
      } catch (err) {
        console.error(`[positions] review failed for ${position.ticker}:`, err.message);
        results.push({ ticker: position.ticker, error: err.message });
      }
    }

    try {
      const warning = costTracker.maybeBudgetWarning();
      if (warning) await sendMessage(warning.message);
    } catch (err) {
      console.error('[budget] warning check failed:', err.message);
    }

    return {
      reviewed: results.length,
      cadenceDays,
      stillDue: Math.max(0, due.length - batch.length),
      results,
    };
  });
});

router.get('/reviews', (req, res) => {
  const context = readContext();
  const all = [...context.positionReviews.history].sort(
    (a, b) => new Date(b.reviewedAt) - new Date(a.reviewedAt)
  );
  const filtered = req.query.positionId ? all.filter((r) => r.positionId === req.query.positionId) : all;
  res.json(filtered);
});

module.exports = router;
