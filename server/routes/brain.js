'use strict';

const express = require('express');
const crypto = require('crypto');
const { readContext, updateContext } = require('../lib/store');
const brain = require('../services/brain');
const council = require('../services/council');

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
  if (!council.anyConfigured()) {
    return res.status(400).json({
      error:
        "No AI provider is configured, so The Brain can't respond yet. Add at least one key to .env — GEMINI_API_KEY (free, https://aistudio.google.com/apikey), ANTHROPIC_API_KEY, or OPENAI_API_KEY — then restart the server.",
      code: 'GEMINI_NOT_CONFIGURED',
    });
  }

  const userMsg = { id: crypto.randomUUID(), role: 'user', content: body.message.trim(), ts: new Date().toISOString() };
  // Persist the user's message immediately, then chat off a fresh snapshot —
  // the LLM await must never sit between a stale read and a write.
  updateContext((ctx) => {
    ctx.brain.messages.push(userMsg);
  });

  try {
    const replyText = await brain.chat(userMsg.content, readContext());
    const assistantMsg = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: replyText,
      ts: new Date().toISOString(),
    };
    updateContext((ctx) => {
      ctx.brain.messages.push(assistantMsg);
    });
    res.json({ userMsg, assistantMsg });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.put('/memory', (req, res) => {
  let memory = null;
  updateContext((context) => {
    context.brain.memory = { ...context.brain.memory, ...(req.body || {}) };
    memory = context.brain.memory;
  });
  res.json(memory);
});

module.exports = router;
