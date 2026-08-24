'use strict';

/**
 * Source attribution.
 *
 * Every number the Council sees comes from somewhere, and where it came from
 * changes how much it is worth. A price computed from Yahoo's own chart data
 * is not the same kind of fact as a revenue figure someone typed into a
 * Telegram channel. Before this existed, both arrived in the prompt looking
 * identical, so the Council had no way to weight them differently — and Yinon
 * had no way to see which channel actually drove an alert.
 *
 * This module builds one consistent "where this came from" block used by
 * Research, convergence alerts and position reviews alike.
 */

// How much weight each kind of source deserves, stated plainly for the models.
const SOURCE_TRUST = {
  computed:
    'HIGH — calculated by this app directly from raw market data. Treat as fact.',
  market_feed:
    'HIGH — pulled live from a market data provider (Yahoo Finance, CNN, frankfurter). Treat as fact, but note the provider can be stale or blocked.',
  channel:
    'UNKNOWN — a claim someone posted in a Telegram channel. It may be accurate, stale, wrong, or promotional. Never treat as fact unless the Fact-Checker confirms it against market data.',
  manual:
    'MEDIUM — Yinon pasted this himself, so he chose to save it, but the underlying claim is still unverified.',
  trending:
    'LOW — surfaced only because retail attention spiked. Popularity is not evidence.',
};

function classifySignalSource(source) {
  const s = String(source || '').toLowerCase();
  if (s.startsWith('telegram:')) return 'channel';
  if (s.includes('manual')) return 'manual';
  if (s.includes('trending')) return 'trending';
  return 'channel';
}

/**
 * Human-readable label for one signal, naming the actual channel.
 */
function describeSignalSource(signal) {
  const raw = signal.source || 'unknown';
  if (raw.startsWith('telegram:')) {
    return `Telegram channel ${raw.replace('telegram:', '')}`;
  }
  if (raw.toLowerCase().includes('manual')) return 'pasted by Yinon';
  return raw;
}

/**
 * Groups signals by channel so the Council can see concentration:
 * three mentions from one channel is one opinion repeated, not three
 * independent sources agreeing. That distinction matters a lot for a
 * convergence alert.
 */
function summariseSignalSources(signals) {
  const byChannel = new Map();
  for (const s of signals || []) {
    const label = describeSignalSource(s);
    if (!byChannel.has(label)) byChannel.set(label, 0);
    byChannel.set(label, byChannel.get(label) + 1);
  }
  const entries = [...byChannel.entries()].sort((a, b) => b[1] - a[1]);
  return {
    distinctSources: entries.length,
    breakdown: entries.map(([label, count]) => ({ source: label, mentions: count })),
    concentrationWarning:
      entries.length === 1 && (signals || []).length > 1
        ? `All ${signals.length} mentions came from ONE source (${entries[0][0]}). That is one opinion repeated, not independent agreement. Weight it accordingly.`
        : null,
  };
}

/**
 * The block injected into Council prompts. Tells the models exactly which
 * data is verified fact and which is someone's unverified claim.
 */
function buildProvenanceBlock({ signals = [], dataFeeds = {}, extraNotes = [] } = {}) {
  const lines = ['=== WHERE THIS INFORMATION CAME FROM ==='];

  lines.push(
    '',
    'Market data in this prompt:',
    ...Object.entries(dataFeeds).map(([name, status]) =>
      status && status.available === false
        ? `- ${name}: NOT AVAILABLE (${status.reason || 'no data'}). There is no number here. Do not invent one.`
        : `- ${name}: ${status && status.source ? status.source : 'live market feed'} — ${SOURCE_TRUST.market_feed}`
    )
  );

  if (signals.length) {
    const summary = summariseSignalSources(signals);
    lines.push(
      '',
      `Signal claims in this prompt (${signals.length} item${signals.length === 1 ? '' : 's'} from ${
        summary.distinctSources
      } source${summary.distinctSources === 1 ? '' : 's'}):`
    );
    for (const b of summary.breakdown) {
      lines.push(`- ${b.source}: ${b.mentions} mention${b.mentions === 1 ? '' : 's'} — ${SOURCE_TRUST.channel}`);
    }
    if (summary.concentrationWarning) {
      lines.push('', `⚠ ${summary.concentrationWarning}`);
    }
  }

  for (const note of extraNotes) lines.push('', note);

  lines.push(
    '',
    'RULES ON SOURCES:',
    '- Anything the app computed or fetched from a market feed may be treated as fact.',
    '- Anything from a Telegram channel is an unverified claim until the Fact-Checker confirms it against market data. Say "the channel claims X" — never "X is true".',
    '- The CFO must name the source of any claim that carries real weight in the final verdict.',
    '- If a key claim has no source you can point to, say so plainly.'
  );

  return lines.join('\n');
}

module.exports = {
  buildProvenanceBlock,
  summariseSignalSources,
  describeSignalSource,
  classifySignalSource,
  SOURCE_TRUST,
};
