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

async function sendMessage(text, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = opts.chatId || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[telegram:stub] BOT token/chat ID not set — logging message instead of sending:');
    console.log(text);
    return { delivered: false, stubbed: true };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram send failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
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
    const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET || undefined;
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

module.exports = { sendMessage, sendBriefing, registerWebhook, isConfigured };
