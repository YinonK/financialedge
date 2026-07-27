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

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxOutputTokens || 2048,
      temperature: opts.temperature != null ? opts.temperature : 0.6,
      system,
      messages: history.map((turn) => ({
        role: turn.role === 'assistant' ? 'assistant' : 'user',
        content: turn.content,
      })),
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Anthropic API error (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }

  const json = JSON.parse(text);
  const out = json.content && json.content.map((c) => c.text || '').join('');
  if (!out) throw new Error('Anthropic returned no usable content.');
  return out;
}

module.exports = { id: 'anthropic', label: `Claude (${MODEL})`, isConfigured, generate };
