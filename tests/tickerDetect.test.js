'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detectTickers, detectCashtags } = require('../server/lib/tickerDetect');

test('detectCashtags: only explicit $ symbols', () => {
  assert.deepStrictEqual(detectCashtags('$NVDA is running, NEXT WEEK EARNINGS'), ['NVDA']);
  assert.deepStrictEqual(detectCashtags('no tickers here'), []);
});

test('detectCashtags: never matches bare caps words', () => {
  // This is the junk that used to flow into convergence as "high confidence".
  assert.deepStrictEqual(detectCashtags('NEXT WEEK EARNINGS GUYS'), []);
});

test('detectTickers: stopwords filtered, cashtags always included', () => {
  const found = detectTickers('CEO says $TSLA and PLTR look strong, IMO');
  assert.ok(found.includes('TSLA'));
  assert.ok(found.includes('PLTR'));
  assert.ok(!found.includes('CEO'));
  assert.ok(!found.includes('IMO'));
});
