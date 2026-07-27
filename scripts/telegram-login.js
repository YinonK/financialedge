'use strict';

/**
 * One-time interactive login to generate a Telegram user session string.
 *
 * Why this exists: reading messages from channels Yinon merely follows
 * (doesn't own/administrate) isn't possible with a plain Bot API token —
 * Telegram's Bot API only sees messages a bot is explicitly added to. The
 * standard workaround is a *user* session via MTProto (the same protocol
 * the Telegram apps use), logged in as Yinon's own account. That's what
 * this script sets up, once.
 *
 * Prerequisites (put these in .env first):
 *   TELEGRAM_API_ID, TELEGRAM_API_HASH — free, from https://my.telegram.org
 *   (log in with your phone number -> "API development tools" -> create an app)
 *
 * Run: npm run telegram:login
 * It will ask for your phone number, the login code Telegram sends you, and
 * your 2FA password if you have one set. At the end it prints a session
 * string — paste that into .env as TELEGRAM_SESSION. After that, the
 * ingestion job (server/services/telegramIngest.js) can log in silently
 * using the saved session, no more interactive prompts.
 *
 * This session string is equivalent to being logged into Telegram as
 * Yinon — treat it like a password. It's .env-only, git-ignored, same as
 * every other secret in this project.
 */

require('dotenv').config();
const readline = require('readline/promises');
const { stdin, stdout } = require('process');

async function main() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
  const apiHash = process.env.TELEGRAM_API_HASH;

  if (!apiId || !apiHash) {
    console.error(
      'Missing TELEGRAM_API_ID / TELEGRAM_API_HASH in .env.\nGet them for free at https://my.telegram.org -> API development tools, then add both to .env and re-run this.'
    );
    process.exit(1);
  }

  let TelegramClient, StringSession;
  try {
    ({ TelegramClient } = require('telegram'));
    ({ StringSession } = require('telegram/sessions'));
  } catch (err) {
    console.error(
      "The 'telegram' package isn't installed. Run `npm install` first (it's already in package.json)."
    );
    process.exit(1);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = (q) => rl.question(q);

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

  console.log('Logging in to Telegram as your personal account (one-time setup)...\n');

  await client.start({
    phoneNumber: () => ask('Phone number, with country code (e.g. +972...): '),
    password: () => ask('2FA password (press enter if you don\'t have one set): '),
    phoneCode: () => ask('Code Telegram just sent you: '),
    onError: (err) => console.error('Login error:', err.message),
  });

  const sessionString = client.session.save();

  console.log('\nLogged in successfully.\n');
  console.log('Add this to your .env as TELEGRAM_SESSION (keep it secret, like a password):\n');
  console.log(sessionString);
  console.log('');

  rl.close();
  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Login failed:', err.message);
  process.exit(1);
});
