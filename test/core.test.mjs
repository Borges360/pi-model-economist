import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FileStore,
  hash,
  canonical,
  redact,
  safePath,
  merge,
  glob,
  timed,
  yamlFile,
  createRuntime,
} from '../lib/core.mjs';
test('canonical order, redaction, glob and prototype rejection', () => {
  assert.equal(hash({ b: 2, a: 1 }), hash({ a: 1, b: 2 }));
  assert.equal(glob('src/**', 'src/a/b.ts'), true);
  assert.equal(glob('**/*.ts', 'a.ts'), true);
  assert.equal(redact({ authorization: 'secret' }).authorization, '[REDACTED]');
  assert.ok(!redact('api_key=supersecret Bearer private').includes('supersecret'));
  assert.throws(() => merge({}, JSON.parse('{"__proto__":{"polluted":1}}')), /Unsafe/);
});
test('file journal idempotency, parallel serialization, tamper detectable signatures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suite-core-'));
  try {
    const s = new FileStore(dir);
    await Promise.all(Array.from({ length: 20 }, () => s.append('audit', { id: 'same', x: 1 })));
    assert.equal((await s.rows('audit')).length, 1);
    const signed = await s.sign({ actor: 'human', value: 1 });
    assert.equal(await s.valid(signed), true);
    signed.payload.value = 2;
    assert.equal(await s.valid(signed), false);
    await assert.rejects(safePath(dir, '../escape'), /outside/);
    await assert.rejects(
      timed(() => new Promise(() => {}), 10),
      /timeout/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('YAML multi-line, anchors bounded and duplicate keys rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suite-yaml-'));
  try {
    const f = join(dir, 'config.yaml');
    await writeFile(
      f,
      'task:\n  id: T-1\n  acceptance:\n    - id: test\n      type: test\n      command: node --test\n',
    );
    assert.equal((await yamlFile(f)).task.acceptance[0].id, 'test');
    await writeFile(f, 'a: 1\na: 2\n');
    await assert.rejects(yamlFile(f), /Invalid YAML/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
