'use strict';

/**
 * Autonomous signal ingestion from Telegram alpha channels — reads recent
 * posts from channels Yinon follows (but doesn't own), so they feed the
 * same convergence detector as manually-pasted signals. This is additive:
 * the Signals screen's manual paste box is untouched.
 *
 * Why MTProto instead of the Bot API: a plain Bot API token only receives
 * messages from chats it's explicitly a member/admin of. Reading posts from
 * public channels Yinon merely follows requires being logged in as a real
 * Telegram user account — that's what the 'telegram' (GramJS) package + a
 * saved session string (from `npm run telegram:login`) give us.
 *
 * Why polling, not a persistent live connection: Render's free tier freezes
 * the whole process when there's no inbound HTTP traffic, so a long-lived
 * MTProto connection would just die with the dyno anyway. Instead, each run
 * spins up a short-lived client, fetches messages newer than the last seen
 * checkpoint per channel, and disconnects — the same "wake on cron, do the
 * work, go back to sleep" shape as the briefing and watchdog.
 *
 * Configuration (.env):
 *   TELEGRAM_API_ID, TELEGRAM_API_HASH — free, from https://my.telegram.org
 *   TELEGRAM_SESSION — generated once via `npm run telegram:login`
 *   TELEGRAM_CHANNELS — comma-separated channel usernames to follow, e.g.
 *     "vider_channel,some_other_channel" (no @ prefix needed, but it's fine
 *     if you include it — it's stripped). We deliberately don't hardcode any
 *     channel names — Yinon supplies the exact handles.
 */

const { detectTickers } = require('../lib/tickerDetect');

function isConfigured() {
  return Boolean(process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH && process.env.TELEGRAM_SESSION);
}

function getConfiguredChannels() {
  const raw = process.env.TELEGRAM_CHANNELS || '';
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean);
}

/**
 * Fetches new messages from each configured channel since the last
 * checkpoint, converts them into the same signal-item shape the Signals
 * screen uses for manual paste, and returns them (caller is responsible for
 * appending to context and persisting — keeps this function side-effect-free
 * and testable).
 */
async function ingestNewSignals(lastMessageIdByChannel) {
  if (!isConfigured()) {
    return {
      configured: false,
      reason:
        'Telegram ingestion not configured. Needs TELEGRAM_API_ID + TELEGRAM_API_HASH (from https://my.telegram.org), TELEGRAM_SESSION (run `npm run telegram:login` once), and TELEGRAM_CHANNELS (comma-separated channel handles) in .env.',
      newItems: [],
      updatedCheckpoints: lastMessageIdByChannel,
    };
  }

  const channels = getConfiguredChannels();
  if (!channels.length) {
    return {
      configured: true,
      reason: 'TELEGRAM_API_ID/HASH/SESSION are set, but TELEGRAM_CHANNELS is empty — nothing to ingest from.',
      newItems: [],
      updatedCheckpoints: lastMessageIdByChannel,
    };
  }

  let TelegramClient, StringSession;
  try {
    ({ TelegramClient } = require('telegram'));
    ({ StringSession } = require('telegram/sessions'));
  } catch (err) {
    return {
      configured: false,
      reason: "The 'telegram' package isn't installed yet — run `npm install`.",
      newItems: [],
      updatedCheckpoints: lastMessageIdByChannel,
    };
  }

  const client = new TelegramClient(
    new StringSession(process.env.TELEGRAM_SESSION),
    parseInt(process.env.TELEGRAM_API_ID, 10),
    process.env.TELEGRAM_API_HASH,
    { connectionRetries: 3 }
  );

  const newItems = [];
  const updatedCheckpoints = { ...lastMessageIdByChannel };
  const errors = [];

  try {
    await client.connect();

    for (const channel of channels) {
      try {
        const sinceId = lastMessageIdByChannel[channel] || 0;
        // getMessages with minId returns messages newer than that ID, oldest-first-ish;
        // limit keeps a single run bounded even after a long sleep.
        const messages = await client.getMessages(channel, { limit: 50, minId: sinceId });

        let maxId = sinceId;
        for (const msg of messages) {
          if (msg.id > maxId) maxId = msg.id;
          const text = msg.message;
          if (!text || !text.trim()) continue;
          const tickers = detectTickers(text);
          newItems.push({
            id: `tg-${channel}-${msg.id}`,
            pastedAt: msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString(),
            rawText: text.trim(),
            tickers,
            source: `telegram:@${channel}`,
          });
        }
        updatedCheckpoints[channel] = maxId;
      } catch (err) {
        errors.push(`${channel}: ${err.message}`);
      }
    }
  } finally {
    await client.disconnect().catch(() => {});
  }

  return { configured: true, newItems, updatedCheckpoints, errors };
}

module.exports = { ingestNewSignals, isConfigured, getConfiguredChannels };
