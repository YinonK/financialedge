'use strict';

/**
 * OpenAI provider. Paid API — needs a card on file at
 * https://platform.openai.com. Key lives in .env only, never the browser.
 */

// GPT-5.6 Terra: mid-tier reasoning at $2/$12 per M tokens. Carries the
// Fact-Checker seat, where hallucination-resistance is the whole job.
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
const API_URL = 'https://api.openai.com/v1/chat/completions';

// A hung socket must never stall a Council run forever (Node's fetch has no
// default timeout). Generous, because reasoning models genuinely take minutes.
const REQUEST_TIMEOUT_MS = 300000;

function isConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

async function generate(systemInstruction, history, opts = {}) {
  if (!isConfigured()) {
    const err = new Error('OPENAI_API_KEY is not set. Get one at https://platform.openai.com (paid, per-token).');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const isReasoningModel = /^(gpt-5|gpt-6|o\d)/.test(MODEL);

  // Reasoning models spend max_completion_tokens on INVISIBLE reasoning tokens
  // before emitting any visible output. If the budget runs out mid-thought you
  // get HTTP 200 with content: "" and finish_reason: "length" — no error, just
  // silence. That is exactly how the OpenAI seat vanished from the Council.
  //
  // The cap is an upper bound, not a reservation: you're billed for tokens
  // actually used, so a generous floor is free insurance rather than a cost.
  const requested = opts.maxOutputTokens || 2048;
  const maxTokens = isReasoningModel
    ? Math.max(requested, Number(process.env.OPENAI_MIN_COMPLETION_TOKENS) || 32000)
    : requested;

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemInstruction },
      ...history.map((turn) => ({
        role: turn.role === 'assistant' ? 'assistant' : 'user',
        content: turn.content,
      })),
    ],
    max_completion_tokens: maxTokens,
  };
  if (opts.json) {
    body.response_format = { type: 'json_object' };
  }
  // Reasoning-family models reject a non-default temperature outright (400).
  if (opts.temperature != null && !isReasoningModel) {
    body.temperature = opts.temperature;
  }
  // Optional lever: lower reasoning effort leaves more of the budget for actual
  // output. Opt-in only — an unsupported value is a 400, and we've already been
  // bitten once by assuming a parameter is safe.
  if (isReasoningModel && process.env.OPENAI_REASONING_EFFORT) {
    body.reasoning_effort = process.env.OPENAI_REASONING_EFFORT;
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

  if (typeof opts.onUsage === 'function' && json.usage) {
    // completion_tokens already includes reasoning tokens — they are billed.
    opts.onUsage({
      provider: 'openai',
      model: MODEL,
      inputTokens: json.usage.prompt_tokens || 0,
      outputTokens: json.usage.completion_tokens || 0,
    });
  }

  const choice = json.choices && json.choices[0];
  const message = choice && choice.message;

  // Chat Completions returns a plain string, but some model families return an
  // array of content parts. Handle both rather than assuming gpt-4-era shape.
  let out = null;
  if (message) {
    if (typeof message.content === 'string') {
      out = message.content;
    } else if (Array.isArray(message.content)) {
      out = message.content.map((part) => (typeof part === 'string' ? part : part.text || '')).join('');
    }
  }

  if (!out || !out.trim()) {
    const finish = choice ? choice.finish_reason : 'unknown';
    const usage = json.usage || {};
    const reasoningTokens =
      (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0;

    // Make the failure self-diagnosing — the generic "no usable content" cost
    // us a production debugging cycle.
    const diagnosis =
      finish === 'length'
        ? `The ${maxTokens}-token budget was exhausted before any visible output (${reasoningTokens} reasoning tokens used). Raise OPENAI_MIN_COMPLETION_TOKENS, or set OPENAI_REASONING_EFFORT=low to leave more budget for the answer.`
        : finish === 'content_filter'
        ? 'The response was blocked by a content filter.'
        : 'The model returned an empty message.';

    throw new Error(
      `OpenAI returned no usable content (model: ${MODEL}, finish_reason: ${finish}, completion_tokens: ${
        usage.completion_tokens != null ? usage.completion_tokens : 'n/a'
      }, reasoning_tokens: ${reasoningTokens}). ${diagnosis}`
    );
  }
  return out;
}

module.exports = { id: 'openai', label: `OpenAI (${MODEL})`, isConfigured, generate };
