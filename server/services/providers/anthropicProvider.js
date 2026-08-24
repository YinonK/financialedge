'use strict';

/**
 * Anthropic (Claude) provider. Paid API — needs a card on file at
 * https://console.anthropic.com. Key lives in .env only, never the browser.
 */

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function generate(systemInstruction, history, opts = {}) {
  if (!isConfigured()) {
    const err = new Error('ANTHROPIC_API_KEY is not set. Get one at https://console.anthropic.com (paid, per-token).');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const system = opts.json
    ? `${systemInstruction}\n\nRespond ONLY with valid JSON. No markdown fences, no prose outside the JSON.`
    : systemInstruction;

  const body = {
    model: MODEL,
    max_tokens: opts.maxOutputTokens || 2048,
    system,
    messages: history.map((turn) => ({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: turn.content,
    })),
  };

  // Temperature is deprecated on newer Claude models and sending it is a hard
  // HTTP 400 — it took the entire Anthropic seat off the Council in production.
  // We don't need it (the role prompts do the steering), so it's omitted by
  // default and only sent if explicitly opted into via ANTHROPIC_TEMPERATURE.
  // Opt-in rather than a model allow-list, so a future model can't break this
  // again the same way.
  if (process.env.ANTHROPIC_TEMPERATURE !== undefined && process.env.ANTHROPIC_TEMPERATURE !== '') {
    const t = Number(process.env.ANTHROPIC_TEMPERATURE);
    if (Number.isFinite(t)) body.temperature = t;
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Anthropic API error (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }

  const json = JSON.parse(text);

  if (typeof opts.onUsage === 'function' && json.usage) {
    opts.onUsage({
      provider: 'anthropic',
      model: MODEL,
      inputTokens: json.usage.input_tokens || 0,
      outputTokens: json.usage.output_tokens || 0,
    });
  }

  // Only take text blocks — thinking blocks have no .text and would otherwise
  // silently contribute empty strings.
  const out =
    json.content &&
    json.content
      .filter((c) => c.type === 'text' || typeof c.text === 'string')
      .map((c) => c.text || '')
      .join('');
  if (!out) {
    throw new Error(
      `Anthropic returned no usable content (stop_reason: ${json.stop_reason || 'unknown'}${
        json.usage ? `, output_tokens: ${json.usage.output_tokens}` : ''
      }). If stop_reason is max_tokens, raise the output budget.`
    );
  }
  return out;
}

module.exports = { id: 'anthropic', label: `Claude (${MODEL})`, isConfigured, generate };
