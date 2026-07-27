'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, writeContext } = require('../lib/store');
const brain = require('../services/brain');
const gemini = require('../services/gemini');

const router = express.Router();

router.get('/messages', (req, res) => {
  const context = readContext();
  res.json(context.brain.messages);
});

router.post('/chat', async (req, res) => {
  const body = req.body || {};
  if (!body.message || !body.message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (!gemini.isConfigured()) {
    return res.status(400).json({
      error:
        "GEMINI_API_KEY is not set, so The Brain can't respond yet. Get a free key at https://aistudio.google.com/apikey and add it to your .env as GEMINI_API_KEY, then restart the server.",
      code: 'GEMINI_NOT_CONFIGURED',
    });
  }

  const context = readContext();
  const userMsg = { id: crypto.randomUUID(), role: 'user', content: body.message.trim(), ts: new Date().toISOString() };
  context.brain.messages.push(userMsg);

  try {
    const replyText = await brain.chat(userMsg.content, context);
    const assistantMsg = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: replyText,
      ts: new Date().toISOString(),
    };
    context.brain.messages.push(assistantMsg);
    writeContext(context);
    res.json({ userMsg, assistantMsg });
  } catch (err) {
    writeContext(context); // keep the user's message even if the reply failed
    res.status(502).json({ error: err.message });
  }
});

router.put('/memory', (req, res) => {
  const context = readContext();
  context.brain.memory = { ...context.brain.memory, ...(req.body || {}) };
  writeContext(context);
  res.json(context.brain.memory);
});

module.exports = router;
