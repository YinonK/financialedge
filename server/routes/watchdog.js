'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, updateContext } = require('../lib/store');
const { checkPositions, isUsMarketHours, detectMaterialEvents } = require('../services/watchdog');
const { reviewPosition, persistReview } = require('../services/positionReview');
const { getIndicators } = require('../services/marketIndicators');
const { sendMessage } = require('../services/telegram');
const { requireCronKey, reportCronFailure } = require('../lib/cronAuth');
const council = require('../services/council');
const costTracker = require('../services/costTracker');
const { SYSTEM_PERSONA } = require('../services/brain');

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
    // Snapshot for computing only — every WRITE below goes through
    // updateContext so nothing written meanwhile can be clobbered.
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
    let councilRead = null;
    if (actionable.length) {
      // A watchdog flag is a significant crossroads — convene the Council
      // for a quick multi-model read before alerting. Failures never block
      // the alert itself.
      try {
        councilRead = await costTracker.metered('watchdog quick take', context.settings, (onUsage) =>
          council.quickTake(
            SYSTEM_PERSONA,
            `Watchdog crossroads for Yinon's book. Flags just raised:\n${actionable
              .map((f) => `- [${f.severity}] ${f.message}`)
              .join('\n')}\n\nOpen positions: ${JSON.stringify(positions)}`,
            { onUsage }
          )
        );
      } catch (err) {
        console.error('[watchdog] council quickTake failed:', err.message);
      }

      const text = `FinancialEdge Watchdog — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\n\n${actionable
        .map((f) => `• ${f.message}`)
        .join('\n')}${councilRead ? `\n\nCouncil read: ${councilRead}` : ''}`;
      delivery = await sendMessage(text);
    }

    // --- Event-triggered Portfolio Council Review ---
    // Beyond price mechanics, look for thesis-relevant events on held names
    // (fresh channel chatter, a structural level break) and re-underwrite
    // just that position immediately. Capped at one per tick: a full review
    // is ~8 model calls and the rest will be caught next tick or by the
    // scheduled sweep.
    const triggeredReviews = [];
    try {
      const events = await detectMaterialEvents(context, positions);
      const event = events[0];
      if (event) {
        const position = positions.find((p) => p.id === event.positionId);
        if (position) {
          const review = await reviewPosition(position, readContext(), {
            trigger: 'event',
            eventReason: event.reason,
          }).catch(async (err) => {
            console.error('[watchdog] event review failed:', err.message);
            return null;
          });

          if (review) {
            // One shared, atomic persistence path: analysis store + review
            // history + seen-signal/level bookkeeping, applied to the live
            // context so this tick's OWN final write can't revert it.
            persistReview(review, { signalIds: event.signalIds, levelName: event.levelName });

            const v = review.verdict || {};
            const base = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
            const emoji = v.thesisStatus === 'BROKEN' ? '🔴' : v.thesisStatus === 'WEAKENING' ? '🟠' : '🟢';
            const link = base
              ? review.analysisId
                ? `\n\nFull Council debate: ${base}/analyses.html?id=${review.analysisId}`
                : `\n\nFull Council debate: ${base}/portfolio.html`
              : '';
            await sendMessage(
              `${emoji} Position Review triggered — ${review.ticker}\n\nWhy now: ${event.reason}\n\nThesis: ${
                v.thesisStatus || 'unknown'
              } · Verdict: ${v.verdict || '—'} · Conviction ${v.conviction != null ? v.conviction + '/10' : '—'}\n${
                v.headline || ''
              }${v.whatChangedSinceEntry ? `\nWhat changed: ${v.whatChangedSinceEntry}` : ''}\n\n${
                v.keyTakeaway || ''
              }${link}`
            ).catch((err) => console.error('[watchdog] review alert failed:', err.message));

            triggeredReviews.push({
              ticker: review.ticker,
              trigger: event.type,
              thesisStatus: v.thesisStatus,
              verdict: v.verdict,
            });
          }
        }
      }
    } catch (err) {
      console.error('[watchdog] event detection failed:', err.message);
    }

    const entry = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      flags,
      councilRead,
      triggeredReviews,
      delivery,
    };
    updateContext((ctx) => {
      ctx.watchdog.history.push(entry);
      if (ctx.watchdog.history.length > 200) ctx.watchdog.history.shift();
    });

    res.json(entry);
  } catch (err) {
    await reportCronFailure('watchdog', err);
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
