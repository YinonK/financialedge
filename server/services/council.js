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

const geminiProvider = require('./providers/geminiProvider');
const anthropicProvider = require('./providers/anthropicProvider');
const openaiProvider = require('./providers/openaiProvider');

const ALL_PROVIDERS = [geminiProvider, anthropicProvider, openaiProvider];

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
function chairProvider() {
  const providers = configuredProviders();
  if (!providers.length) return null;
  const preferred = process.env.AI_CHAIR;
  return providers.find((p) => p.id === preferred) || providers[0];
}

async function chairGenerate(systemInstruction, history, opts = {}) {
  const chair = chairProvider();
  if (!chair) {
    const err = new Error(
      'No AI provider configured. Add at least one key to .env: GEMINI_API_KEY (free, https://aistudio.google.com/apikey), ANTHROPIC_API_KEY, or OPENAI_API_KEY.'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return chair.generate(systemInstruction, history, opts);
}

function stripFences(text) {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function tryParse(text) {
  try {
    return JSON.parse(stripFences(text));
  } catch (err) {
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
    providers.map((p) => p.generate(systemPersona, [{ role: 'user', content: prompt }], { json: true }))
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
      return provider.generate(systemPersona, [{ role: 'user', content: rebuttalPrompt }], { json: true });
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
    const merged = await chair.generate(systemPersona, [{ role: 'user', content: mergePrompt }], { json: true });
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
    providers.map((p) => p.generate(systemPersona, [{ role: 'user', content: prompt }], { json: false, maxOutputTokens: 300 }))
  );

  const takes = [];
  providers.forEach((p, i) => {
    if (results[i].status === 'fulfilled') takes.push({ provider: p.id, label: p.label, text: results[i].value.trim() });
  });

  if (!takes.length) return null;
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
      { json: false, maxOutputTokens: 300 }
    );
    return merged.trim();
  } catch (err) {
    return takes[0].text;
  }
}

module.exports = {
  deliberate,
  quickTake,
  chairGenerate,
  chairProvider,
  configuredProviders,
  anyConfigured,
};
