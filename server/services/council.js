'use strict';

/**
 * The Council — multi-model negotiation.
 *
 * Every configured AI provider (Gemini free tier, Claude, OpenAI — any
 * subset) weighs in on significant decisions:
 *
 *   Round 1  — each model independently produces its own take from the
 *              same Five Lenses data.
 *   Round 2  — each model sees the others' takes (anonymized as Analyst
 *              A/B/C to avoid brand deference) and must rebut or concede,
 *              then submit a revised take.
 *   Verdict  — the chair model merges revised takes into one consensus,
 *              REQUIRED to surface disagreements rather than paper over
 *              them. A split council is signal, not noise.
 *
 * With one provider configured this collapses gracefully to a single-model
 * take (no negotiation, no extra cost). With zero, callers get the same
 * clear "not configured" message as before.
 *
 * Read-only like everything else: the Council argues and recommends;
 * Yinon executes. No path from any conclusion to any order anywhere.
 */

const registry = require('./providers');
const roles = require('./roles');

const ALL_PROVIDERS = registry.all();

/**
 * Per-provider health, so a dead key, an exhausted quota, or a provider
 * outage is visible instead of silently shrinking the Council. Nothing here
 * is persisted — it's the live picture since the last server start, which is
 * what you want when diagnosing "why did the Council only have one voice?"
 */
const health = {}; // { [providerId]: { ok, lastOkAt, lastErrorAt, lastError, consecutiveFailures } }

function recordSuccess(id) {
  const h = health[id] || {};
  health[id] = {
    ...h,
    ok: true,
    lastOkAt: new Date().toISOString(),
    lastError: null,
    consecutiveFailures: 0,
  };
}

function recordFailure(id, message) {
  const h = health[id] || {};
  health[id] = {
    ...h,
    ok: false,
    lastErrorAt: new Date().toISOString(),
    lastError: message,
    consecutiveFailures: (h.consecutiveFailures || 0) + 1,
  };
}

/**
 * Every provider call goes through here so health is always current and a
 * failure is always logged with the provider that caused it.
 */
async function callProvider(provider, systemInstruction, historyOrPrompt, opts) {
  try {
    const out = await provider.generate(systemInstruction, historyOrPrompt, opts);
    recordSuccess(provider.id);
    return out;
  } catch (err) {
    recordFailure(provider.id, err.message);
    console.error(`[council] ${provider.id} call failed:`, err.message);
    throw err;
  }
}

/**
 * Health snapshot for /api/health and the Home ops panel, with a plain-language
 * hint about what to actually do when something is broken.
 */
function getProviderHealth() {
  return ALL_PROVIDERS.map((p) => {
    const configured = p.isConfigured();
    const h = health[p.id] || {};
    return {
      id: p.id,
      label: p.label,
      configured,
      status: !configured ? 'not_configured' : h.ok === false ? 'failing' : h.ok === true ? 'ok' : 'untested',
      lastOkAt: h.lastOkAt || null,
      lastErrorAt: h.lastErrorAt || null,
      lastError: h.lastError || null,
      consecutiveFailures: h.consecutiveFailures || 0,
      hint: !configured ? null : h.ok === false ? hintFor(p.id, h.lastError) : null,
    };
  });
}

function hintFor(id, error) {
  const e = (error || '').toLowerCase();
  if (e.includes('503') || e.includes('high demand') || e.includes('unavailable')) {
    return 'Provider is overloaded right now (common on Gemini\'s free tier). Usually clears on its own — the Council keeps running on the other providers meanwhile.';
  }
  if (e.includes('429') || e.includes('quota') || e.includes('rate')) {
    return 'Rate limit or quota exhausted. Wait for the window to reset, or add billing to raise the limit.';
  }
  if (e.includes('401') || e.includes('403') || e.includes('api key') || e.includes('unauthorized') || e.includes('authentication')) {
    return id === 'gemini'
      ? 'Key rejected. Check GEMINI_API_KEY in Render → Environment (free key at aistudio.google.com/apikey).'
      : id === 'anthropic'
      ? 'Key rejected. Check ANTHROPIC_API_KEY in Render → Environment (console.anthropic.com).'
      : 'Key rejected. Check OPENAI_API_KEY in Render → Environment (platform.openai.com).';
  }
  if (e.includes('credit') || e.includes('billing') || e.includes('insufficient')) {
    return 'Account is out of credit. Top up billing for this provider to bring it back into the Council.';
  }
  if (e.includes('404') || e.includes('not found') || e.includes('no longer available')) {
    return 'The configured model name is not available to this account. Set the matching *_MODEL env var to a model your account can use.';
  }
  return 'Check the provider\'s dashboard and the Render logs for details.';
}

function configuredProviders() {
  return ALL_PROVIDERS.filter((p) => p.isConfigured());
}

function anyConfigured() {
  return configuredProviders().length > 0;
}

/**
 * The chair: used for single-voice jobs (chat, briefing narrative, merging
 * council output). Defaults to the first configured provider; override with
 * AI_CHAIR=gemini|anthropic|openai in .env.
 */
/**
 * Single source of truth for who chairs. Delegates to roles.assignChair so
 * the chair used by chairGenerate and the chair the Catfish is told to avoid
 * can never disagree — they did briefly, and the Catfish ended up dodging the
 * wrong model.
 */
function chairProvider() {
  const providers = configuredProviders();
  if (!providers.length) return null;
  return roles.assignChair(providers, process.env.AI_CHAIR);
}

/**
 * Single-voice generation with automatic failover.
 *
 * The chair speaks first, but providers go down — Gemini's free tier in
 * particular returns 503 "high demand" fairly often. Rather than fail the
 * whole request when the chair is unavailable, fall through to the other
 * configured providers in order. Only throws if every provider fails,
 * and then reports what each one said.
 */
async function chairGenerate(systemInstruction, history, opts = {}) {
  const providers = configuredProviders();
  if (!providers.length) {
    const err = new Error(
      'No AI provider configured. Add at least one key to .env: GEMINI_API_KEY (free, https://aistudio.google.com/apikey), ANTHROPIC_API_KEY, or OPENAI_API_KEY.'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const chair = chairProvider();
  const ordered = [chair, ...providers.filter((p) => p.id !== chair.id)];

  const failures = [];
  for (const provider of ordered) {
    try {
      return await callProvider(provider, systemInstruction, history, opts);
    } catch (err) {
      failures.push(`${provider.id}: ${err.message}`);
    }
  }

  throw new Error(`All AI providers failed. ${failures.join(' | ')}`);
}

function stripFences(text) {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function tryParse(text) {
  const cleaned = stripFences(text);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // Models sometimes wrap JSON in prose or thinking preamble — extract the
    // outermost {...} block and try that before giving up.
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch (err2) {
        return null;
      }
    }
    return null;
  }
}

const ANON_LABELS = ['Analyst A', 'Analyst B', 'Analyst C'];

/**
 * Full negotiation on a structured decision (research calls).
 *
 * @param {string} systemPersona - shared Brain persona
 * @param {string} prompt - the task + data
 * @param {string} schema - JSON schema description all takes must follow
 * @returns {{ providersUsed, round1, round2, consensus, errors }}
 */
async function deliberate(systemPersona, prompt, schema) {
  const providers = configuredProviders();
  if (!providers.length) {
    const err = new Error(
      'No AI provider configured. Add at least one key to .env: GEMINI_API_KEY (free, https://aistudio.google.com/apikey), ANTHROPIC_API_KEY, or OPENAI_API_KEY.'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const errors = [];

  // ---- Round 1: independent takes ----
  const round1Results = await Promise.allSettled(
    providers.map((p) => callProvider(p, systemPersona, [{ role: 'user', content: prompt }], { json: true }))
  );

  const round1 = [];
  providers.forEach((p, i) => {
    const r = round1Results[i];
    if (r.status === 'fulfilled') {
      const parsed = tryParse(r.value);
      if (parsed) {
        round1.push({ provider: p.id, label: p.label, take: parsed });
      } else {
        errors.push(`${p.id}: round 1 returned unparseable JSON`);
      }
    } else {
      errors.push(`${p.id}: round 1 failed — ${r.reason.message}`);
    }
  });

  if (!round1.length) {
    throw new Error(`All providers failed in round 1: ${errors.join(' | ')}`);
  }

  // Single voice — no negotiation possible or needed.
  if (round1.length === 1) {
    return {
      providersUsed: round1.map((r) => r.label),
      round1,
      round2: null,
      consensus: round1[0].take,
      negotiated: false,
      errors,
    };
  }

  // ---- Round 2: rebuttal + revision ----
  const round2Results = await Promise.allSettled(
    round1.map((mine, i) => {
      const othersTakes = round1
        .filter((_, j) => j !== i)
        .map((other, j) => `${ANON_LABELS[j]}:\n${JSON.stringify(other.take, null, 2)}`)
        .join('\n\n');

      const rebuttalPrompt = `${prompt}

You already gave this take:
${JSON.stringify(mine.take, null, 2)}

Other analysts on the desk gave these takes on the same data:
${othersTakes}

Where they disagree with you, decide: are they seeing something you missed, or are they wrong? Don't converge for the sake of harmony — hold your position if the data backs it, concede specifically where it doesn't.

Respond with JSON matching the same schema as before, plus one extra field:
"rebuttal": string  // 2-4 sentences: what you reject or concede from the other takes, and why
Schema reminder:
${schema}`;

      const provider = providers.find((p) => p.id === mine.provider);
      return callProvider(provider, systemPersona, [{ role: 'user', content: rebuttalPrompt }], { json: true });
    })
  );

  const round2 = [];
  round1.forEach((mine, i) => {
    const r = round2Results[i];
    if (r.status === 'fulfilled') {
      const parsed = tryParse(r.value);
      if (parsed) {
        round2.push({ provider: mine.provider, label: mine.label, take: parsed });
        return;
      }
    }
    errors.push(`${mine.provider}: round 2 failed, falling back to their round-1 take`);
    round2.push({ provider: mine.provider, label: mine.label, take: mine.take });
  });

  // ---- Final: chair merges into consensus ----
  const chair = chairProvider();
  const mergePrompt = `You are chairing an investment desk. ${round2.length} analysts have debated the same data and submitted final takes:

${round2.map((r, i) => `${ANON_LABELS[i]}:\n${JSON.stringify(r.take, null, 2)}`).join('\n\n')}

Merge them into ONE final consensus take, as JSON matching this schema:
${schema}

Plus two extra fields:
"disagreements": string  // where the analysts genuinely split and why it matters — never paper over a real split; if they disagree on the verdict itself, say so bluntly
"councilAlignment": "unanimous"|"majority"|"split"

Rules: a split council on a high-risk trade should pull the conviction score DOWN and usually lands on WATCH, not BUY. Where analysts converged after debate, weight that agreement heavily.`;

  let consensus = null;
  try {
    // chairGenerate (not chair.generate) so a chair outage falls through to
    // another provider rather than losing the merged consensus entirely.
    const merged = await chairGenerate(systemPersona, [{ role: 'user', content: mergePrompt }], { json: true });
    consensus = tryParse(merged);
  } catch (err) {
    errors.push(`chair merge failed: ${err.message}`);
  }
  if (!consensus) {
    // Fall back to the chair's own round-2 take rather than dropping everything.
    const chairTake = round2.find((r) => r.provider === chair.id) || round2[0];
    consensus = chairTake.take;
    errors.push('consensus fell back to a single take (merge unparseable)');
  }

  return {
    providersUsed: round1.map((r) => r.label),
    round1,
    round2,
    consensus,
    negotiated: true,
    errors,
  };
}

/**
 * Lighter-weight council for time-sensitive moments (watchdog crossroads,
 * fresh signal convergence): one independent round, chair synthesizes a
 * short shared read. No rebuttal round — speed matters more at an alert.
 */
async function quickTake(systemPersona, situation) {
  const providers = configuredProviders();
  if (!providers.length) return null;

  const prompt = `${situation}

Give your read in 2-3 sharp sentences: what this means, and what Yinon should be looking at (never an instruction to trade — he decides). No preamble.`;

  const results = await Promise.allSettled(
    providers.map((p) => p.generate(systemPersona, [{ role: 'user', content: prompt }], { json: false, maxOutputTokens: 2048 }))
  );

  const takes = [];
  providers.forEach((p, i) => {
    if (results[i].status === 'fulfilled') {
      takes.push({ provider: p.id, label: p.label, text: results[i].value.trim() });
    } else {
      console.error(`[council:quickTake] ${p.id} failed:`, results[i].reason && results[i].reason.message);
    }
  });

  // Every provider failed — say so in the alert rather than silently
  // dropping the Council's read, so a dead key/quota is visible immediately.
  if (!takes.length) {
    return `(Council unavailable — all AI providers failed: ${providers
      .map((p, i) => `${p.id}: ${results[i].reason ? results[i].reason.message.slice(0, 120) : 'unknown'}`)
      .join(' | ')})`;
  }
  if (takes.length === 1) return takes[0].text;

  try {
    const chair = chairProvider();
    const merged = await chair.generate(
      systemPersona,
      [
        {
          role: 'user',
          content: `${takes.length} analysts gave these quick reads on the same event:\n\n${takes
            .map((t, i) => `${ANON_LABELS[i]}: ${t.text}`)
            .join('\n\n')}\n\nMerge into ONE read of max 3 sentences. If they disagree, lead with the disagreement — that's the headline.`,
        },
      ],
      { json: false, maxOutputTokens: 2048 }
    );
    return merged.trim();
  } catch (err) {
    return takes[0].text;
  }
}

const SIGNAL_SCHEMA = `{
  "headline": string,                  // one sharp line: what is actually happening with these names
  "whatChannelsAreSaying": string,     // the substance of the chatter, not just that it exists
  "caseFor": string,                   // why this could be a real opportunity
  "caseForNoise": string,              // why this could be hype, promotion, or coincidence
  "keyRisk": string,                   // the single thing most likely to burn this
  "priority": "high"|"medium"|"low",   // how much of Yinon's attention this deserves right now
  "worthResearching": boolean          // should he run a full Five Lenses on it
}`;

/**
 * Full Council brainstorm on a fresh signal convergence — the same
 * independent-takes → rebuttals → consensus flow as a research call, because
 * a convergence is exactly the moment worth arguing about. Returns formatted
 * text ready for a Telegram alert, plus the structured result.
 *
 * Degrades cleanly: whichever providers are alive do the thinking; a dead
 * provider is dropped from the Council and named in the output so Yinon can
 * see the Council ran short-handed and go fix it.
 */
async function brainstormSignals(systemPersona, situation) {
  const providers = configuredProviders();
  if (!providers.length) {
    return { text: '(No AI provider configured — add a key to get the Council\'s read.)', result: null };
  }

  const prompt = `${situation}

Brainstorm this convergence as a desk. Be concrete about what these names are and why the chatter clustered now. Never tell Yinon to place a trade — he decides and executes everything himself.

Respond as JSON matching this schema exactly:
${SIGNAL_SCHEMA}`;

  try {
    const result = await deliberate(systemPersona, prompt, SIGNAL_SCHEMA);
    const c = result.consensus || {};

    const lines = [];
    if (c.headline) lines.push(c.headline);
    lines.push('');
    if (c.whatChannelsAreSaying) lines.push(`Chatter: ${c.whatChannelsAreSaying}`);
    if (c.caseFor) lines.push(`For: ${c.caseFor}`);
    if (c.caseForNoise) lines.push(`Noise case: ${c.caseForNoise}`);
    if (c.keyRisk) lines.push(`Key risk: ${c.keyRisk}`);
    if (c.priority) lines.push(`Priority: ${c.priority}${c.worthResearching ? ' — worth a full Five Lenses' : ''}`);
    if (c.disagreements) lines.push(`Council split: ${c.disagreements}`);

    const voices = result.providersUsed.length;
    const total = providers.length;
    lines.push('');
    lines.push(
      `— Council: ${result.providersUsed.join(', ')}${result.negotiated ? ' (negotiated)' : ' (single voice)'}${
        voices < total ? ` ⚠ ${total - voices} provider(s) unavailable — check Home → Brain Operations` : ''
      }`
    );

    return { text: lines.join('\n'), result };
  } catch (err) {
    return {
      text: `(Council unavailable — every AI provider failed: ${err.message.slice(0, 300)}. Check Home → Brain Operations.)`,
      result: null,
    };
  }
}

/**
 * Convene the full role-based Council.
 *
 * Each seat (Bull, Bear, Risk Manager, Fact-Checker, Macro Analyst) analyzes
 * the same situation in parallel under its own adversarial mandate, then the
 * CFO synthesizes — with the Risk Manager carrying veto weight and verified
 * facts kept explicitly separate from unverified signal claims.
 *
 * Degrades honestly: seats that fail are dropped and named, and the CFO is
 * told which seats are missing so it can't pretend they agreed. With a single
 * provider configured, one model plays every seat — still worthwhile, because
 * the adversarial structure lives in the prompts, not in the model diversity.
 *
 * @returns {{ ok, verdict, seats, missingSeats, providersUsed, errors }}
 */
async function convene(situation, opts = {}) {
  const providers = configuredProviders();
  if (!providers.length) {
    const err = new Error(
      'No AI provider configured. Add at least one key to .env: GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const errors = [];
  const assignments = roles.assignRoles(providers, opts.roleIds);

  // Reflection: what we said about this name before and how it played out,
  // plus any calibration lesson the track record actually supports. Free —
  // it's context, not an extra model call.
  const situationWithReflection = opts.reflection
    ? `${situation}\n\n${opts.reflection}`
    : situation;

  // --- All seats deliberate in parallel ---
  const seatResults = await Promise.allSettled(
    assignments.map(({ role, provider }) =>
      callProvider(
        provider,
        `${roles.SHARED_CONTEXT}\n\nYour seat on the Council: ${role.title}.`,
        [{ role: 'user', content: roles.buildRolePrompt(role, situationWithReflection) }],
        { json: true, maxOutputTokens: opts.maxOutputTokens || 8192 }
      )
    )
  );

  const seats = [];
  assignments.forEach(({ role, provider, usingPreferred }, i) => {
    const r = seatResults[i];
    if (r.status !== 'fulfilled') {
      errors.push(`${role.title} (${provider.id}): ${r.reason.message}`);
      return;
    }
    const parsed = tryParse(r.value);
    if (!parsed) {
      errors.push(`${role.title} (${provider.id}): returned unparseable JSON`);
      return;
    }
    seats.push({
      roleId: role.id,
      title: role.title,
      providerId: provider.id,
      providerLabel: provider.label,
      usingPreferredProvider: usingPreferred,
      output: parsed,
    });
  });

  if (!seats.length) {
    throw new Error(`Every Council seat failed. ${errors.join(' | ')}`);
  }

  // --- CFO draft synthesis (with failover if the chair provider is down) ---
  const chairSystem = `${roles.SHARED_CONTEXT}\n\nYour seat on the Council: ${roles.CHAIR_ROLE.title} (chair).`;
  const chairPrompt = roles.buildChairPrompt(situationWithReflection, seats, opts.extraChairFields);
  let verdict = null;
  try {
    const merged = await chairGenerate(chairSystem, [{ role: 'user', content: chairPrompt }], {
      json: true,
      maxOutputTokens: opts.maxOutputTokens || 8192,
    });
    verdict = tryParse(merged);
  } catch (err) {
    errors.push(`CFO synthesis failed: ${err.message}`);
  }

  if (!verdict) {
    errors.push('CFO synthesis unavailable — returning raw seat output without a merged verdict.');
  }

  // --- Catfish: mandatory opposition, and it has teeth ---
  // Runs against the CFO's draft, on a different model from the chair where
  // possible — a seat attacking a draft it wrote itself is compromised.
  let catfish = null;
  let revised = false;
  if (verdict && opts.catfish !== false) {
    const chair = roles.assignChair(providers, process.env.AI_CHAIR);
    const catfishProvider =
      roles.CATFISH_ROLE.preferredProviders
        .map((pid) => providers.find((p) => p.id === pid && p.id !== chair.id))
        .find(Boolean) ||
      providers.find((p) => p.id !== chair.id) ||
      chair;

    try {
      const catfishRaw = await callProvider(
        catfishProvider,
        `${roles.SHARED_CONTEXT}\n\nYour seat on the Council: ${roles.CATFISH_ROLE.title}.`,
        [{ role: 'user', content: roles.buildCatfishPrompt(situationWithReflection, seats, verdict) }],
        { json: true, maxOutputTokens: opts.maxOutputTokens || 8192 }
      );
      const parsedCatfish = tryParse(catfishRaw);
      if (!parsedCatfish) {
        errors.push('Catfish returned unparseable JSON — no opposition applied.');
      } else {
        catfish = {
          providerId: catfishProvider.id,
          providerLabel: catfishProvider.label,
          sameModelAsChair: catfishProvider.id === chair.id,
          output: parsedCatfish,
        };

        // The objection is binding: if the Catfish demands revision, the CFO
        // must answer it. Otherwise this seat is decoration.
        if (parsedCatfish.demandsRevision) {
          try {
            const revisedRaw = await chairGenerate(
              chairSystem,
              [
                {
                  role: 'user',
                  content: roles.buildChairRevisionPrompt(
                    situationWithReflection,
                    verdict,
                    parsedCatfish,
                    opts.extraChairFields
                  ),
                },
              ],
              { json: true, maxOutputTokens: opts.maxOutputTokens || 8192 }
            );
            const revisedVerdict = tryParse(revisedRaw);
            if (revisedVerdict) {
              verdict = {
                ...revisedVerdict,
                draftBeforeCatfish: { verdict: verdict.verdict, conviction: verdict.conviction },
              };
              revised = true;
            } else {
              errors.push('Catfish demanded revision but the CFO revision was unparseable — draft verdict stands.');
            }
          } catch (err) {
            errors.push(`Catfish-forced CFO revision failed: ${err.message} — draft verdict stands.`);
          }
        }
      }
    } catch (err) {
      errors.push(`Catfish seat failed: ${err.message} — verdict stands unchallenged.`);
    }
  }

  const missingSeats = Object.values(roles.ROLES)
    .filter((r) => !seats.some((s) => s.roleId === r.id))
    .map((r) => r.title);

  return {
    ok: Boolean(verdict),
    verdict,
    seats,
    catfish,
    revisedAfterCatfish: revised,
    missingSeats,
    providersUsed: [...new Set(seats.map((s) => s.providerLabel))],
    errors,
  };
}

/**
 * Convenience wrapper: convene the Council with reflection automatically
 * pulled from the decision journal for this ticker. Callers that already have
 * a context object should use this rather than convene() directly, so the
 * Council never debates a name we've been wrong about before without being
 * reminded of it.
 */
async function conveneWithMemory(situation, context, ticker, opts = {}) {
  const reflection = require('./reflection').buildReflection(context, ticker);
  return convene(situation, { ...opts, reflection });
}

module.exports = {
  convene,
  conveneWithMemory,
  deliberate,
  brainstormSignals,
  quickTake,
  chairGenerate,
  chairProvider,
  configuredProviders,
  anyConfigured,
  getProviderHealth,
  ROLES: roles.ROLES,
};
