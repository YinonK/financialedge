'use strict';

// The journal is the learning loop's ground truth — a sign error here doesn't
// misreport one trade, it feeds inverted outcomes into every calibration
// lesson. (The original closeEntry had `? 1 : 1` and recorded shorts wrong.)

const test = require('node:test');
const assert = require('node:assert');
const journal = require('../server/services/journal');

test('closeEntry: long position P&L has the right sign', () => {
  const entry = journal.createEntry({ ticker: 'NVDA', action: 'BUY', side: 'long', shares: 10, price: 100 });
  const closed = journal.closeEntry(entry, { exitPrice: 110 });
  assert.strictEqual(closed.outcome.pnlUsd, 100);
  assert.strictEqual(closed.outcome.pnlPct, 10);
  assert.strictEqual(closed.outcome.result, 'win');
});

test('closeEntry: SHORT position profits when price falls', () => {
  const entry = journal.createEntry({ ticker: 'TSLA', action: 'SHORT', side: 'short', shares: 10, price: 100 });
  const closed = journal.closeEntry(entry, { exitPrice: 80 });
  assert.strictEqual(closed.outcome.pnlUsd, 200);
  assert.strictEqual(closed.outcome.pnlPct, 20);
  assert.strictEqual(closed.outcome.result, 'win');
});

test('closeEntry: SHORT position loses when price rises', () => {
  const entry = journal.createEntry({ ticker: 'TSLA', action: 'SHORT', side: 'short', shares: 5, price: 100 });
  const closed = journal.closeEntry(entry, { exitPrice: 120 });
  assert.strictEqual(closed.outcome.pnlUsd, -100);
  assert.strictEqual(closed.outcome.result, 'loss');
});

test('createEntry: defaults side to long, keeps SHORT action', () => {
  const long = journal.createEntry({ ticker: 'aapl', action: 'buy' });
  assert.strictEqual(long.side, 'long');
  assert.strictEqual(long.ticker, 'AAPL');

  const short = journal.createEntry({ ticker: 'X', action: 'SHORT', side: 'short' });
  assert.strictEqual(short.side, 'short');
  assert.strictEqual(short.action, 'SHORT');
});

test('scorecard: buckets by conviction and alignment', () => {
  const entries = [
    journal.closeEntry(
      journal.createEntry({ ticker: 'A', action: 'BUY', shares: 1, price: 10, conviction: 9, council: { alignment: 'unanimous' } }),
      { exitPrice: 15 }
    ),
    journal.closeEntry(
      journal.createEntry({ ticker: 'B', action: 'BUY', shares: 1, price: 10, conviction: 3, council: { alignment: 'split' } }),
      { exitPrice: 5 }
    ),
    journal.createEntry({ ticker: 'C', action: 'WATCH' }), // open — should not count
  ];
  const stats = journal.scorecard(entries);
  assert.strictEqual(stats.closedDecisions, 2);
  assert.strictEqual(stats.wins, 1);
  assert.strictEqual(stats.losses, 1);
  assert.strictEqual(stats.hitRatePct, 50);
  assert.strictEqual(stats.byConviction['high (8-10)'].n, 1);
  assert.strictEqual(stats.byCouncilAlignment.split.n, 1);
});
