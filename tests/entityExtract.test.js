'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { looksFinancial, hasNonLatinScript } = require('../server/services/entityExtract');

test('looksFinancial: Hebrew financial cues pass', () => {
  assert.strictEqual(looksFinancial('קבוצת דלק מדווחת על עלייה של 12% ברווח הרבעוני'), true);
});

test('looksFinancial: greetings are filtered', () => {
  assert.strictEqual(looksFinancial('בוקר טוב לכולם'), false);
  assert.strictEqual(looksFinancial('good morning everyone!!'), false);
});

test('looksFinancial: English financial cues pass', () => {
  assert.strictEqual(looksFinancial('Company raised guidance for the quarter'), true);
});

test('hasNonLatinScript: detects Hebrew', () => {
  assert.strictEqual(hasNonLatinScript('טבע'), true);
  assert.strictEqual(hasNonLatinScript('TEVA'), false);
});
