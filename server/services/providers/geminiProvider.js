'use strict';

/**
 * Gemini provider. Server-side only — the key never reaches the browser.
 */

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

async function generate(systemInstruction, history, opts = {}) {
  if (!isConfigured()) {
    const err = new Error('GEMINI_API_KEY is not set. Free key at https://aistudio.google.com/apikey');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const url = `${API_BASE}/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: history.map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content }],
    })),
    generationConfig: {
      temperature: opts.temperature != null ? opts.temperature : 0.6,
      maxOutputTokens: opts.maxOutputTokens || 2048,
      responseMimeType: opts.json ? 'application/json' : 'text/plain',
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini API error (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }

  const json = JSON.parse(text);
  const candidate = json.candidates && json.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  const out = parts && parts.map((p) => p.text || '').join('');
  if (!out) throw new Error('Gemini returned no usable content (possibly blocked by safety filters).');
  return out;
}

module.exports = { id: 'gemini', label: `Gemini (${MODEL})`, isConfigured, generate };
