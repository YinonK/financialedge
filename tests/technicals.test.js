'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rsi, sma, fibonacciLevels } = require('../server/services/yahooFinance');

test('rsi: all-up series reads 100', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.strictEqual(rsi(closes), 100);
});

test('rsi: all-down series reads near 0', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.ok(rsi(closes) < 1);
});

test('rsi: insufficient data returns null', () => {
  assert.strictEqual(rsi([1, 2, 3]), null);
});

test('rsi: balanced series sits mid-range (Wilder smoothing)', () => {
  // alternate +1/-1 forever — gains and losses balance, RSI should hover ~50
  const closes = [100];
  for (let i = 1; i < 60; i++) closes.push(closes[i - 1] + (i % 2 ? 1 : -1));
  const v = rsi(closes);
  assert.ok(v > 40 && v < 60, `expected mid-range RSI, got ${v}`);
});

test('sma: simple average of the last period', () => {
  assert.strictEqual(sma([1, 2, 3, 4, 5], 5), 3);
  assert.strictEqual(sma([1, 2], 5), null);
});

test('fibonacciLevels: retracements between high and low', () => {
  const fib = fibonacciLevels(200, 100);
  assert.strictEqual(fib.retracements[0], 200);
  assert.strictEqual(fib.retracements[1], 100);
  assert.strictEqual(fib.retracements[0.5], 150);
});
