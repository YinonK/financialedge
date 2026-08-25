'use strict';

/**
 * Outbound Telegram delivery — used by the briefing, the watchdog, and any
 * time The Brain wants to proactively alert Yinon or ask him a clarifying
 * question. Stubbed to console.log when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 * are missing from .env, so every pipeline that calls this still runs
 * end-to-end in dev without a bot configured — nothing crashes, nothing is
 * silently skipped without a trace in the logs.
 *
 * Setup (same pattern as the Gemini key): message @BotFather on Telegram,
 * send /newbot, follow the prompts — you get a token back immediately, no
 * approval wait. For the chat ID: message your new bot anything first, then
 * open https://api.telegram.org/bot<token>/getUpdates in a browser and read
 * "chat":{"id": ...} from the JSON, or just message @userinfobot to get your
 * own numeric ID (works for a DM chat_id).
 */

function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

const REQUEST_TIMEOUT_MS = 15000;

async function sendMessage(text, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = opts.chatId || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[telegram:stub] BOT token/chat ID not set — logging message instead of sending:');
    console.log(text);
    return { delivered: false, stubbed: true };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const attempt = (payload) =>
    fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  let res = await attempt({ chat_id: chatId, text, parse_mode: 'Markdown' });
  if (res.status === 400) {
    // Model-generated text with an unbalanced * or _ makes Telegram reject the
    // whole message as bad Markdown. Losing an alert over formatting is worse
    // than losing the formatting — retry as plain text.
    res = await attempt({ chat_id: chatId, text });
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram send failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  return { delivered: true, stubbed: false };
}

/**
 * Sends a file (used by the weekly backup). Content is a string or Buffer.
 */
async function sendDocument(filename, content, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log(`[telegram:stub] would send document ${filename} (${Buffer.byteLength(content)} bytes)`);
    return { delivered: false, stubbed: true };
  }

  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([content], { type: 'application/json' }), filename);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendDocument failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  return { delivered: true, stubbed: false };
}

/**
 * Registers (or clears) the webhook Telegram will POST inbound messages to,
 * so Yinon's replies in the chat make it back into The Brain. Called once at
 * startup if a public base URL is known (Render sets RENDER_EXTERNAL_URL
 * automatically; PUBLIC_BASE_URL is a manual override for local/ngrok testing).
 * Failures are logged, never thrown — this must never crash the server.
 */
async function registerWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
  if (!token || !baseUrl) {
    console.log(
      '[telegram] Skipping webhook registration (need TELEGRAM_BOT_TOKEN + a public URL — set PUBLIC_BASE_URL locally, or deploy to Render where RENDER_EXTERNAL_URL is automatic).'
    );
    return { registered: false };
  }
  try {
    const webhookUrl = `${baseUrl.replace(/\/$/, '')}/api/telegram/webhook`;
    // Without a secret token, anyone who finds the webhook URL can POST fake
    // "updates" and the only gate left is the chat-id match. Default to
    // CRON_KEY so the webhook is authenticated even with no extra env var.
    const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET || process.env.CRON_KEY || undefined;
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, secret_token: secretToken }),
    });
    const json = await res.json();
    if (!json.ok) {
      console.error('[telegram] setWebhook failed:', json.description);
      return { registered: false, error: json.description };
    }
    console.log(`[telegram] Webhook registered at ${webhookUrl}`);
    return { registered: true, url: webhookUrl };
  } catch (err) {
    console.error('[telegram] setWebhook error:', err.message);
    return { registered: false, error: err.message };
  }
}

// Backwards-compatible alias — the briefing route was written against this name.
const sendBriefing = sendMessage;

module.exports = { sendMessage, sendDocument, sendBriefing, registerWebhook, isConfigured };
