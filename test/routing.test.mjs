import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { assess, choose } from '../routing.mjs';
const small = {
  provider: 'p',
  id: 'small',
  api: 'x',
  input: ['text'],
  cost: { input: 1, output: 1 },
};
const strong = {
  provider: 'p',
  id: 'strong',
  api: 'x',
  input: ['text', 'image'],
  cost: { input: 8, output: 8 },
};
test('simple uses cheapest, risky and ambiguous use capable fallback', () => {
  assert.equal(choose([small, strong], 'Explique este método').selected.id, 'small');
  assert.equal(choose([small, strong], 'delete production database').selected.id, 'strong');
  assert.equal(choose([small, strong], 'fix concurrency').selected.id, 'strong');
  assert.equal(assess('hi').simple, true);
});
test('no virtual or unconfigured models and image compatibility', () => {
  assert.equal(choose([small, strong], 'hi', { images: true }).selected.id, 'strong');
  assert.throws(() => choose([{ ...small, api: 'pi-virtual' }], 'hi'), /no eligible/);
});
