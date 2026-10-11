import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { redact, semanticSource } from '../lib/core.mjs';
test('quoted secrets and CLI credentials are removed without retaining space-separated fragments', () => {
  assert.ok(!redact('--password "private words"').includes('words'));
  assert.ok(!redact('api_key="private words"').includes('words'));
  assert.ok(!redact('postgres://person:private@localhost').includes('private'));
});
test('semantic normalization ignores whitespace/comments but preserves string values and token boundaries', () => {
  assert.equal(
    semanticSource('const value = 1; // note'),
    semanticSource(' const value=1; /* other note */'),
  );
  assert.notEqual(
    semanticSource('const x="hello world";'),
    semanticSource('const x="helloworld";'),
  );
  assert.notEqual(semanticSource('const value=1;'), semanticSource('constvalue=1;'));
  assert.notEqual(
    semanticSource(String.raw`const x="a\" b";`),
    semanticSource(String.raw`const x="a\" c";`),
  );
});
