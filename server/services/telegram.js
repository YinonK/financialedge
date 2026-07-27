'use strict';

/**
 * Telegram delivery for the weekday briefing. Stubbed to console.log when
 * TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are missing from .env — this lets
 * the briefing pipeline run end-to-end in dev without a bot configured.
 * Actual Telegram signal ingestion (reading messages back in) is a later
 * phase and out of scope here; this is outbound delivery only.
 */

async function sendBriefing(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[telegram:stub] BOT token/chat ID not set — logging briefing instead of sending:');
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

module.exports = { sendBriefing };
