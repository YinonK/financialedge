'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, updateContext } = require('../lib/store');
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
    // Mirrors registerWebhook: the secret defaults to CRON_KEY, so the
    // webhook is authenticated even when TELEGRAM_WEBHOOK_SECRET isn't set.
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET || process.env.CRON_KEY;
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

    // Slash commands first. /help and /status answer instantly from local
    // state with no model call; /ask just forwards its text to the Brain.
    // Anything that isn't a command is normal chat, exactly as before.
    const commandResult = await require('../services/telegramCommands').handleCommand(message.text);
    if (commandResult.handled && commandResult.reply) {
      await sendMessage(commandResult.reply);
      return;
    }
    const effectiveText = commandResult.chatMessage || message.text;

    const userMsg = {
      id: crypto.randomUUID(),
      role: 'user',
      content: effectiveText,
      ts: new Date().toISOString(),
      source: 'telegram',
    };
    // Append via updateContext so a slow LLM reply below can't clobber
    // whatever else (ingest, watchdog) writes in the meantime.
    updateContext((ctx) => {
      ctx.brain.messages.push(userMsg);
    });

    if (!require('../services/council').anyConfigured()) {
      await sendMessage(
        "No AI provider is set up yet, so I can't think this through — add GEMINI_API_KEY (free, https://aistudio.google.com/apikey), ANTHROPIC_API_KEY, or OPENAI_API_KEY to .env and restart the server."
      );
      return;
    }

    const replyText = await brain.chat(userMsg.content, readContext());
    const assistantMsg = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: replyText,
      ts: new Date().toISOString(),
      source: 'telegram',
    };
    updateContext((ctx) => {
      ctx.brain.messages.push(assistantMsg);
    });

    await sendMessage(replyText);
  } catch (err) {
    console.error('[telegram:webhook] error handling update:', err.message);
  }
});

module.exports = router;
