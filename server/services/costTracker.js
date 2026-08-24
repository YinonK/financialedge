'use strict';

/**
 * Cost tracking and soft budget guard.
 *
 * Prices real token usage reported by each provider (not estimates from
 * string lengths) against a rate table, accumulates a monthly total, and
 * projects where the month is heading.
 *
 * Deliberately SOFT: when spend trends toward the ceiling it tells Yinon and
 * lets him decide. It never silently drops seats, shortens prompts, or
 * downgrades models — a system that quietly gets dumber to save money is
 * worse than one that costs a few dollars more, because you stop being able
 * to trust what you're reading.
 */

const { readContext, writeContext } = require('../lib/store');

/**
 * USD per 1M tokens. These are defaults — they go stale as vendors reprice,
 * so they're overridable from Settings without a code change (see
 * settings.pricingOverrides).
 *
 * Confirmed at build time:
 *   gpt-5.6-terra    $2 / $12   (verified against OpenAI pricing)
 *   gemini 3.x Pro   $1 / $6
 *   claude-sonnet-5  $2 / $10   <- ESTIMATE, worth confirming on the invoice
 */
const DEFAULT_PRICING = {
  gemini: { input: 1.0, output: 6.0 },
  anthropic: { input: 2.0, output: 10.0 },
  openai: { input: 2.0, output: 12.0 },
};

// Model-specific overrides where a provider's cheap tier differs a lot.
const MODEL_PRICING = {
  'gemini-flash-latest': { input: 0.075, output: 0.3 },
  'gemini-3.6-flash': { input: 0.075, output: 0.3 },
  'gemini-2.0-flash': { input: 0.075, output: 0.3 },
};

function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

function rateFor(providerId, model, settings) {
  const overrides = (settings && settings.pricingOverrides) || {};
  if (overrides[model]) return overrides[model];
  if (overrides[providerId]) return overrides[providerId];
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  return DEFAULT_PRICING[providerId] || { input: 0, output: 0 };
}

function priceUsage(usage, settings) {
  const rate = rateFor(usage.provider, usage.model, settings);
  const cost =
    (usage.inputTokens / 1e6) * rate.input + (usage.outputTokens / 1e6) * rate.output;
  return { ...usage, rate, costUsd: cost };
}

/**
 * Collects usage across a single Council run so we can attribute cost to the
 * run, not just to the month. Create one per convene(), pass its `record` as
 * the onUsage callback, then `summary()` for the totals.
 */
function createRunMeter(settings) {
  const items = [];
  return {
    record(usage) {
      try {
        items.push(priceUsage(usage, settings));
      } catch (err) {
        console.error('[costTracker] failed to price usage:', err.message);
      }
    },
    summary() {
      const totalUsd = items.reduce((s, i) => s + i.costUsd, 0);
      const byProvider = {};
      for (const i of items) {
        if (!byProvider[i.provider]) byProvider[i.provider] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        const b = byProvider[i.provider];
        b.calls++;
        b.inputTokens += i.inputTokens;
        b.outputTokens += i.outputTokens;
        b.costUsd += i.costUsd;
      }
      for (const k of Object.keys(byProvider)) byProvider[k].costUsd = +byProvider[k].costUsd.toFixed(6);
      return {
        calls: items.length,
        totalUsd: +totalUsd.toFixed(6),
        inputTokens: items.reduce((s, i) => s + i.inputTokens, 0),
        outputTokens: items.reduce((s, i) => s + i.outputTokens, 0),
        byProvider,
      };
    },
  };
}

/**
 * Folds a completed run's cost into the persisted monthly total.
 * Re-reads context immediately before writing to avoid clobbering concurrent
 * writes from parallel Council runs.
 */
function commitRunCost(runSummary, label) {
  if (!runSummary || !runSummary.calls) return null;
  const context = readContext();
  const key = monthKey();

  if (!context.costs.months[key]) {
    context.costs.months[key] = { totalUsd: 0, runs: 0, calls: 0, byProvider: {} };
  }
  const m = context.costs.months[key];
  m.totalUsd = +(m.totalUsd + runSummary.totalUsd).toFixed(6);
  m.runs += 1;
  m.calls += runSummary.calls;
  for (const [pid, b] of Object.entries(runSummary.byProvider)) {
    if (!m.byProvider[pid]) m.byProvider[pid] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const t = m.byProvider[pid];
    t.calls += b.calls;
    t.inputTokens += b.inputTokens;
    t.outputTokens += b.outputTokens;
    t.costUsd = +(t.costUsd + b.costUsd).toFixed(6);
  }

  context.costs.recentRuns.push({
    ts: new Date().toISOString(),
    label: label || 'council run',
    totalUsd: runSummary.totalUsd,
    calls: runSummary.calls,
    byProvider: runSummary.byProvider,
  });
  if (context.costs.recentRuns.length > 200) context.costs.recentRuns.shift();

  writeContext(context);
  return m;
}

/**
 * Where is this month heading? Straight-line projection from spend-to-date.
 */
function projectMonth(context, now = new Date()) {
  const key = monthKey(now);
  const m = (context.costs && context.costs.months && context.costs.months[key]) || {
    totalUsd: 0,
    runs: 0,
    calls: 0,
    byProvider: {},
  };
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const projectedUsd = dayOfMonth > 0 ? (m.totalUsd / dayOfMonth) * daysInMonth : 0;

  const ceiling =
    (context.settings && context.settings.budgetCeilingUsd != null
      ? Number(context.settings.budgetCeilingUsd)
      : 30) || 30;
  const warnAt =
    (context.settings && context.settings.budgetWarnFraction != null
      ? Number(context.settings.budgetWarnFraction)
      : 0.8) || 0.8;

  return {
    month: key,
    spentUsd: +m.totalUsd.toFixed(4),
    runs: m.runs,
    calls: m.calls,
    byProvider: m.byProvider,
    dayOfMonth,
    daysInMonth,
    projectedUsd: +projectedUsd.toFixed(2),
    ceilingUsd: ceiling,
    warnThresholdUsd: +(ceiling * warnAt).toFixed(2),
    percentOfCeiling: ceiling ? +((projectedUsd / ceiling) * 100).toFixed(0) : 0,
    overCeiling: m.totalUsd >= ceiling,
    projectedOverCeiling: projectedUsd >= ceiling,
    shouldWarn: projectedUsd >= ceiling * warnAt,
  };
}

/**
 * Warn at most once per day so a busy day doesn't spam. Returns the message
 * to send, or null if we've already warned today / there's nothing to say.
 */
function maybeBudgetWarning() {
  const context = readContext();
  const projection = projectMonth(context);
  if (!projection.shouldWarn) return null;

  const today = new Date().toISOString().slice(0, 10);
  if (context.costs.lastWarnedOn === today) return null;

  context.costs.lastWarnedOn = today;
  writeContext(context);

  const msg = projection.overCeiling
    ? `Heads up: AI spend this month is $${projection.spentUsd}, which is over your $${projection.ceilingUsd} limit.

Nothing has been switched off — the Council is still running at full strength. I'm telling you rather than quietly making it cheaper, because a system that gets weaker without saying so is not worth trusting.

If you want to spend less, you can raise or lower the limit in Settings, or reduce how often the scheduled jobs run.`
    : `Heads up: AI spend is on track for about $${projection.projectedUsd} this month, against your $${projection.ceilingUsd} limit. So far you have spent $${projection.spentUsd}.

Nothing has changed and nothing is switched off. Just letting you know early, so it is your decision.

You can change the limit or the job schedules in Settings.`;

  return { message: msg, projection };
}

module.exports = {
  createRunMeter,
  commitRunCost,
  projectMonth,
  maybeBudgetWarning,
  priceUsage,
  DEFAULT_PRICING,
  monthKey,
};
