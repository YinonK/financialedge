'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, writeContext } = require('../lib/store');
const { checkPositions, isUsMarketHours, detectMaterialEvents } = require('../services/watchdog');
const { reviewPosition } = require('../services/positionReview');
const { getIndicators } = require('../services/marketIndicators');
const { sendMessage } = require('../services/telegram');
const { requireCronKey } = require('../lib/cronAuth');
const council = require('../services/council');
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
        councilRead = await council.quickTake(
          SYSTEM_PERSONA,
          `Watchdog crossroads for Yinon's book. Flags just raised:\n${actionable
            .map((f) => `- [${f.severity}] ${f.message}`)
            .join('\n')}\n\nOpen positions: ${JSON.stringify(positions)}`
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
            const fresh = readContext();
            fresh.positionReviews.history.push({
              id: crypto.randomUUID(),
              positionId: review.positionId,
              ticker: review.ticker,
              trigger: review.trigger,
              eventReason: review.eventReason,
              reviewedAt: review.reviewedAt,
              snapshot: review.snapshot,
              verdict: review.verdict,
              seats: review.seats,
              catfish: review.catfish,
              revisedAfterCatfish: review.revisedAfterCatfish,
              missingSeats: review.missingSeats,
              providersUsed: review.providersUsed,
              errors: review.errors,
            });
            if (fresh.positionReviews.history.length > 200) fresh.positionReviews.history.shift();
            fresh.positionReviews.lastReviewedAt[review.positionId] = review.reviewedAt;

            // Mark the triggering signals seen so this doesn't re-fire every tick.
            if (event.signalIds && event.signalIds.length) {
              const prev = fresh.positionReviews.seenSignalIds[event.positionId] || [];
              fresh.positionReviews.seenSignalIds[event.positionId] = [...prev, ...event.signalIds].slice(-200);
            }
            writeContext(fresh);

            const v = review.verdict || {};
            const base = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
            const emoji = v.thesisStatus === 'BROKEN' ? '🔴' : v.thesisStatus === 'WEAKENING' ? '🟠' : '🟢';
            await sendMessage(
              `${emoji} Position Review triggered — ${review.ticker}\n\nWhy now: ${event.reason}\n\nThesis: ${
                v.thesisStatus || 'unknown'
              } · Verdict: ${v.verdict || '—'} · Conviction ${v.conviction != null ? v.conviction + '/10' : '—'}\n${
                v.headline || ''
              }${v.whatChangedSinceEntry ? `\nWhat changed: ${v.whatChangedSinceEntry}` : ''}\n\n${
                v.keyTakeaway || ''
              }${base ? `\n\nFull Council debate: ${base}/portfolio.html` : ''}`
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
