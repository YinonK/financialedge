'use strict';

/**
 * OpenAI provider. Paid API — needs a card on file at
 * https://platform.openai.com. Key lives in .env only, never the browser.
 */

const MODEL = process.env.OPENAI_MODEL || 'gpt-5';
const API_URL = 'https://api.openai.com/v1/chat/completions';

function isConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

async function generate(systemInstruction, history, opts = {}) {
  if (!isConfigured()) {
    const err = new Error('OPENAI_API_KEY is not set. Get one at https://platform.openai.com (paid, per-token).');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemInstruction },
      ...history.map((turn) => ({
        role: turn.role === 'assistant' ? 'assistant' : 'user',
        content: turn.content,
      })),
    ],
    max_completion_tokens: opts.maxOutputTokens || 2048,
  };
  if (opts.json) {
    body.response_format = { type: 'json_object' };
  }
  // Newer OpenAI reasoning-family models reject non-default temperature;
  // only pass it for models known to accept it.
  if (opts.temperature != null && !/^(gpt-5|o\d)/.test(MODEL)) {
    body.temperature = opts.temperature;
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI API error (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }

  const json = JSON.parse(text);
  const out = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!out) throw new Error('OpenAI returned no usable content.');
  return out;
}

module.exports = { id: 'openai', label: `OpenAI (${MODEL})`, isConfigured, generate };
