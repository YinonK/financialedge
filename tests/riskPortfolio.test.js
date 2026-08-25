'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { computeZone, sizePosition, pearson } = require('../server/services/riskPortfolio');

test('computeZone: long breachedStop / hitTarget', () => {
  const p = { stopPrice: 90, targetPrice: 120, side: 'long' };
  assert.strictEqual(computeZone(p, 85).breachedStop, true);
  assert.strictEqual(computeZone(p, 125).hitTarget, true);
  const mid = computeZone(p, 105);
  assert.strictEqual(mid.breachedStop, false);
  assert.strictEqual(mid.hitTarget, false);
  assert.strictEqual(mid.pctToTarget, 50);
});

test('computeZone: short direction is inverted', () => {
  const p = { stopPrice: 110, targetPrice: 80, side: 'short' };
  assert.strictEqual(computeZone(p, 115).breachedStop, true); // price ABOVE stop breaches a short
  assert.strictEqual(computeZone(p, 75).hitTarget, true); // price BELOW target wins a short
});

test('computeZone: no stop/target returns null', () => {
  assert.strictEqual(computeZone({ stopPrice: null, targetPrice: 100 }, 90), null);
});

test('sizePosition: 2% risk cap off stop distance', () => {
  const s = sizePosition({ accountEquity: 100000, entryPrice: 50, stopPrice: 45 });
  assert.strictEqual(s.maxDollarRisk, 2000);
  assert.strictEqual(s.suggestedShares, 400); // 2000 / 5
});

test('pearson: perfectly correlated series is 1', () => {
  const a = [0.01, -0.02, 0.03, 0.01, -0.01];
  assert.ok(Math.abs(pearson(a, a) - 1) < 1e-9);
});
