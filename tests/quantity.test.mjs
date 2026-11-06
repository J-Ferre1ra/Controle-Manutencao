import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNumericQuantity } from '../src/lib/quantity.js';

test('parses Brazilian thousands and decimal separators', () => {
  assert.equal(parseNumericQuantity('1.234,5 km'), 1234.5);
  assert.equal(parseNumericQuantity('1.000 árvores'), 1000);
  assert.equal(parseNumericQuantity('1.234.567,89'), 1234567.89);
});

test('keeps decimal values and parses international formats', () => {
  assert.equal(parseNumericQuantity('1,25 unidades'), 1.25);
  assert.equal(parseNumericQuantity('1,234'), 1.234);
  assert.equal(parseNumericQuantity('1,234,567'), 1234567);
  assert.equal(parseNumericQuantity('1,234.5'), 1234.5);
  assert.equal(parseNumericQuantity('12.5'), 12.5);
});

test('returns null when no quantity is present', () => {
  assert.equal(parseNumericQuantity(''), null);
  assert.equal(parseNumericQuantity('Sem previsão'), null);
  assert.equal(parseNumericQuantity(undefined), null);
});
