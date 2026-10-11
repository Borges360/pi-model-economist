import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import install from '../extension.mjs';
import { fakePi } from '../test-support/fakes.mjs';
test('sticky continuation/retry, serialized state, explicit manual physical selection untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'economist-runtime-'));
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  try {
    await mkdir(join(dir, '.pi'));
    await writeFile(
      join(dir, '.pi', 'pi-suite.yaml'),
      'modelEconomist:\n  mode: rules\n  candidates:\n    - id: fake/small\n      tier: 1\n      tools: true\n    - id: fake/strong\n      tier: 3\n      tools: true\n',
    );
    const models = ['small', 'strong'].map((id, i) => ({
      provider: 'fake',
      id,
      api: 'test',
      input: ['text'],
      contextWindow: 100000,
      cost: { input: i + 1, output: i + 1 },
    }));
    const f = fakePi(dir, models);
    install(f.pi);
    await f.emit('session_start');
    const first = await f.pi.virtual.route(
      { reason: 'user', messages: [{ role: 'user', content: 'hello' }], thinkingLevel: 'off' },
      f.ctx,
    );
    assert.equal(first.model.id, 'small');
    assert.doesNotThrow(() => JSON.stringify(first.state));
    const follow = await f.pi.virtual.route(
      { reason: 'continuation', previous: first, state: first.state, messages: [] },
      f.ctx,
    );
    assert.equal(follow.model.id, 'small');
    await f.command('economist', 'mode manual');
    assert.equal(f.ctx.model.id, 'small');
    await f.emit('session_shutdown');
  } finally {
    if (old === undefined) delete process.env.PI_SUITE_HOME;
    else process.env.PI_SUITE_HOME = old;
    await rm(dir, { recursive: true, force: true });
  }
});
