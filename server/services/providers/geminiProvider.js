'use strict';

/**
 * Gemini provider. Server-side only — the key never reaches the browser.
 */

// Rolling alias, not a pinned version — pinned IDs get retired for new
// accounts without warning (gemini-2.5-flash 404'd on us in production).
// Defaults to Pro: this provider carries the Macro / Live-Web Analyst seat on
// the Council, where grounding quality matters more than per-token cost.
// Override with GEMINI_MODEL (e.g. gemini-flash-latest to run cheap).
const MODEL = process.env.GEMINI_MODEL || 'gemini-pro-latest';
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
      // Newer Gemini models "think" before answering and the thinking spends
      // from this same budget — too small a cap truncates the actual answer.
      maxOutputTokens: opts.maxOutputTokens || 16384,
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
  // Skip "thought" parts thinking models sometimes include alongside the answer.
  const out = parts && parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (!out) {
    const reason = candidate && candidate.finishReason;
    throw new Error(
      `Gemini returned no usable content${reason ? ` (finishReason: ${reason})` : ''} — possibly blocked or the output budget was exhausted by thinking.`
    );
  }
  return out;
}

module.exports = { id: 'gemini', label: `Gemini (${MODEL})`, isConfigured, generate };
