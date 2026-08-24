'use strict';

/**
 * Telegram slash commands.
 *
 * Anything that is NOT a slash command goes straight to the Brain as normal
 * chat — that behaviour is unchanged and is still the main way to talk to it.
 * Commands exist for the things you want instantly and repeatedly, without
 * spending a model call to answer them.
 *
 * Written at B2 level, same as everything else Yinon reads.
 */

const { readContext } = require('../lib/store');
const council = require('./council');
const costTracker = require('./costTracker');
const telegramIngest = require('./telegramIngest');

function appBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
}

function parseCommand(text) {
  const trimmed = (text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  // Telegram sends /help@YourBotName in groups — strip the bot suffix.
  const match = trimmed.match(/^\/([a-zA-Z0-9_]+)(?:@\S+)?\s*([\s\S]*)$/);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: (match[2] || '').trim() };
}

function helpText() {
  const base = appBaseUrl();
  return `Here is what I can do.

*Just type a question* — no command needed. I know your positions, your recent channel signals, and everything we have discussed before. Ask me things like:
• "why is my NVDA position down?"
• "what did we say about PLTR last month?"
• "explain what RSI means"

*Commands*
/ask <question> — same as typing a question. Useful if you want to be explicit.
/status — how the system is doing: which AI models are working, what I have spent this month, when things last ran.
/help — this message.

*What I do on my own*
• Read your Telegram channels and spot when the same stock keeps coming up
• Watch your open positions against your stops and targets
• Re-check whether the reason you bought something is still true
• Look for new opportunities each day
• Send you a briefing each weekday morning and a review each Saturday

*What I never do*
I never buy, sell, or move a stop. Not ever. I only look, think, and tell you. Every trade is your decision and your click.${
    base ? `\n\nThe full app, with every debate saved: ${base}` : ''
  }`;
}

async function statusText() {
  const context = readContext();
  const providers = council.getProviderHealth().filter((p) => p.configured);
  const working = providers.filter((p) => p.status !== 'failing');
  const spend = costTracker.projectMonth(context);

  const providerLines = providers.length
    ? providers
        .map((p) => {
          const mark = p.status === 'ok' ? '✅' : p.status === 'failing' ? '❌' : '⏳';
          const detail = p.status === 'failing' ? `\n   Problem: ${(p.lastError || '').slice(0, 120)}` : '';
          return `${mark} ${p.label}${detail}`;
        })
        .join('\n')
    : '❌ No AI model is set up.';

  const lastReview = (context.positionReviews.history || []).slice(-1)[0];
  const lastHunt = (context.opportunities.history || []).slice(-1)[0];
  const lastBriefing = (context.briefing.history || []).slice(-1)[0];
  const when = (item, key) => (item ? new Date(item[key]).toLocaleString() : 'not yet');

  const positions = context.portfolio.positions || [];
  const analyses = (context.analyses.history || []).length;

  return `*System status*

*AI Council*
${providerLines}
${
  working.length >= 2
    ? `The Council is debating across ${working.length} different models.`
    : working.length === 1
    ? 'Only one model is working, so there is no real debate right now. The seats still argue, but one model plays every role.'
    : 'No model is working. Analysis is paused until this is fixed.'
}

*Spending this month*
$${spend.spentUsd.toFixed(2)} so far, over ${spend.runs} Council run${spend.runs === 1 ? '' : 's'}.
On track for about $${spend.projectedUsd.toFixed(2)} against your $${spend.ceilingUsd} limit.
${spend.projectedOverCeiling ? 'That would go over your limit. Nothing is switched off — it is your call.' : 'That is inside your limit.'}

*Your book*
${positions.length} open position${positions.length === 1 ? '' : 's'}${positions.length ? `: ${positions.map((p) => p.ticker).join(', ')}` : ''}
${analyses} saved Council debate${analyses === 1 ? '' : 's'}

*Last runs*
Morning briefing: ${when(lastBriefing, 'ts')}
Opportunity hunt: ${when(lastHunt, 'ts')}
Position re-check: ${when(lastReview, 'reviewedAt')}

*Channels I read*
${telegramIngest.getConfiguredChannels().map((c) => `@${c}`).join(', ') || 'none set up'}`;
}

/**
 * Returns { handled, reply, chatMessage }.
 *  - handled=false  -> not a command, treat as normal chat
 *  - reply          -> send this text directly, no model call needed
 *  - chatMessage    -> send this to the Brain as chat (used by /ask)
 */
async function handleCommand(text) {
  const parsed = parseCommand(text);
  if (!parsed) return { handled: false };

  switch (parsed.command) {
    case 'help':
    case 'start':
      return { handled: true, reply: helpText() };

    case 'status':
      try {
        return { handled: true, reply: await statusText() };
      } catch (err) {
        return { handled: true, reply: `Could not read the status: ${err.message}` };
      }

    case 'ask':
      if (!parsed.args) {
        return { handled: true, reply: 'Ask me something after the command, like: /ask why is NVDA falling?' };
      }
      return { handled: true, chatMessage: parsed.args };

    default:
      return {
        handled: true,
        reply: `I do not know the command /${parsed.command}. Send /help to see what I can do — or just type your question normally.`,
      };
  }
}

module.exports = { handleCommand, parseCommand, helpText, statusText };
