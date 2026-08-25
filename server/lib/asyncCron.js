'use strict';

/**
 * Long-running cron endpoints, acknowledged immediately.
 *
 * WHY THIS EXISTS
 * A full Council run takes 2-3 minutes. cron-job.org gives up at 30 seconds
 * and records a FAILURE — and after enough recorded failures it disables the
 * job outright. That was written off as cosmetic. It is not: it is exactly how
 * the Signal Ingest and Watchdog jobs died silently for five days, taking the
 * alpha feed with them.
 *
 * So these endpoints now answer 202 straight away and keep working in the
 * background. The scheduler sees a fast, honest success — it genuinely did
 * hand the work over — and the real result reaches Yinon the way it always
 * did: through Telegram.
 *
 * What we give up: the HTTP response no longer carries the result. That was
 * only ever read by a scheduler that discards it. Pass ?wait=true to get the
 * old blocking behaviour with the full payload, which is what you want when
 * testing an endpoint by hand.
 *
 * Overlap protection: one run per job at a time. A 15-minute ingest schedule
 * against a 3-minute run is normally fine, but if a provider hangs we must not
 * stack up Council runs (each one costs real money).
 */

const { flushStore } = require('./store');
const { reportCronFailure } = require('./cronAuth');

// jobName -> ISO timestamp of when the in-flight run started
const running = new Map();

/**
 * @param {string} jobName  human-readable, used in logs and failure alerts
 * @param {object} req      express request (checked for ?wait=true)
 * @param {object} res      express response
 * @param {function} work   async () => result. Runs to completion regardless
 *                          of when the response was sent.
 */
async function runCronJob(jobName, req, res, work) {
  const startedAt = running.get(jobName);
  if (startedAt) {
    // Not an error: the previous run simply hasn't finished. Say so plainly
    // rather than starting a second one.
    return res.status(202).json({
      accepted: false,
      job: jobName,
      reason: 'a previous run is still in progress — skipping this tick',
      runningSince: startedAt,
    });
  }

  running.set(jobName, new Date().toISOString());

  // Blocking mode, for manual testing: behaves exactly as before.
  if (req.query.wait === 'true') {
    try {
      const result = await work();
      return res.json(result);
    } catch (err) {
      await reportCronFailure(jobName, err);
      return res.status(500).json({ error: err.message });
    } finally {
      running.delete(jobName);
      flushStore().catch(() => {});
    }
  }

  res.status(202).json({
    accepted: true,
    job: jobName,
    note: 'Work started. This job runs longer than a scheduler will wait, so it reports back over Telegram rather than in this response. Add ?wait=true to block for the full result.',
  });

  // Background. Nothing after this point may throw into Express — the
  // response is already sent, and an unhandled rejection would take the
  // process down with it.
  try {
    await work();
  } catch (err) {
    console.error(`[cron:${jobName}] background run failed:`, err.message);
    await reportCronFailure(jobName, err).catch(() => {});
  } finally {
    running.delete(jobName);
    // Make the run's writes durable now rather than waiting for the next
    // write to flush the queue.
    try {
      await flushStore();
    } catch (err) {
      console.error(`[cron:${jobName}] flush after run failed:`, err.message);
    }
  }
}

/** Which jobs are mid-run — surfaced on /api/health for debugging. */
function runningJobs() {
  return [...running.entries()].map(([job, since]) => ({ job, since }));
}

module.exports = { runCronJob, runningJobs };
