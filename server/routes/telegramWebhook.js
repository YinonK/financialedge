'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, writeContext } = require('../lib/store');
const brain = require('../services/brain');
const { sendMessage } = require('../services/telegram');

const router = express.Router();

// Inbound Telegram messages land here (registered via services/telegram.js's
// registerWebhook at startup). This is what makes the bot bidirectional:
// Yinon can reply to an alert, or just message the bot directly, and it
// feeds straight into The Brain's chat context — same memory, same
// portfolio/signals awareness as the Brain Chat screen. Read-only as
// always: The Brain can discuss and recommend, never execute.
router.post('/', async (req, res) => {
  // Always 200 quickly so Telegram doesn't retry-storm us, even on bad input.
  res.status(200).json({ ok: true });

  try {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret) {
      const providedSecret = req.get('X-Telegram-Bot-Api-Secret-Token');
      if (providedSecret !== expectedSecret) {
        console.warn('[telegram:webhook] rejected update — bad secret token');
        return;
      }
    }

    const update = req.body || {};
    const message = update.message || update.edited_message;
    if (!message || !message.text) return; // ignore non-text updates (stickers, photos, etc.)

    const chatId = String(message.chat && message.chat.id);
    const expectedChatId = String(process.env.TELEGRAM_CHAT_ID || '');
    if (!expectedChatId || chatId !== expectedChatId) {
      console.warn(`[telegram:webhook] ignoring message from unexpected chat id ${chatId}`);
      return;
    }

    const context = readContext();
    const userMsg = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message.text,
      ts: new Date().toISOString(),
      source: 'telegram',
    };
    context.brain.messages.push(userMsg);

    if (!require('../services/gemini').isConfigured()) {
      await sendMessage(
        "GEMINI_API_KEY isn't set yet, so I can't think this through — add a free key from https://aistudio.google.com/apikey to .env as GEMINI_API_KEY and restart the server."
      );
      writeContext(context);
      return;
    }

    const replyText = await brain.chat(userMsg.content, context);
    const assistantMsg = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: replyText,
      ts: new Date().toISOString(),
      source: 'telegram',
    };
    context.brain.messages.push(assistantMsg);
    writeContext(context);

    await sendMessage(replyText);
  } catch (err) {
    console.error('[telegram:webhook] error handling update:', err.message);
  }
});

module.exports = router;
