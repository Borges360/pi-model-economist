import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, validateConfig } from '../lib/core.mjs';
import { fakePi } from '../test-support/fakes.mjs';
import { defaults } from '../routing.mjs';
test('global locked policy cannot be loosened by trusted project; no database backend accepted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suite-config-'));
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  try {
    await mkdir(process.env.PI_SUITE_HOME);
    await mkdir(join(dir, '.pi'));
    await writeFile(
      join(process.env.PI_SUITE_HOME, 'config.yaml'),
      'modelEconomist:\n  classifier:\n    allowRemote: false\nlocked:\n  modelEconomist:\n    classifier:\n      allowRemote: false\n',
    );
    await writeFile(
      join(dir, '.pi', 'pi-suite.yaml'),
      'modelEconomist:\n  classifier:\n    allowRemote: true\n',
    );
    const f = fakePi(dir);
    const rt = createRuntime(f.pi, 'test', defaults);
    await rt.init(f.ctx);
    assert.equal(rt.config.modelEconomist.classifier.allowRemote, false);
    await rt.dispose();
    await writeFile(join(dir, '.pi', 'pi-suite.yaml'), 'suite:\n  storage:\n    type: sqlite\n');
    await assert.rejects(
      createRuntime(f.pi, 'test', defaults).init(f.ctx),
      /databases are disabled/,
    );
  } finally {
    if (old === undefined) delete process.env.PI_SUITE_HOME;
    else process.env.PI_SUITE_HOME = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test('role preferences accept only known roles, model ids, and explicit fallback flags', () => {
  assert.doesNotThrow(() =>
    validateConfig({
      modelEconomist: {
        rolePreferences: {
          planner: { model: 'openrouter/planner', effort: 'high', allowFallback: false },
          executor: { model: null, effort: 'medium', allowFallback: true },
          reviewer: { model: 'openrouter/reviewer' },
        },
      },
    }),
  );
  assert.throws(
    () => validateConfig({ modelEconomist: { rolePreferences: { admin: { model: 'p/m' } } } }),
    /role preference name/,
  );
  assert.throws(
    () => validateConfig({ modelEconomist: { rolePreferences: { planner: { model: 'p/m', allowFallback: 'yes' } } } }),
    /role preference for planner/,
  );
  assert.throws(
    () => validateConfig({ modelEconomist: { rolePreferences: { planner: { effort: 'turbo' } } } }),
    /role preference for planner/,
  );
});

test('a save whose signal is already aborted writes nothing, even while queued behind another save', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suite-save-abort-'));
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  try {
    await mkdir(join(dir, '.pi'));
    await writeFile(join(dir, '.pi', 'pi-suite.yaml'), 'modelEconomist:\n  mode: rules\n');
    const f = fakePi(dir);
    const rt = createRuntime(f.pi, 'test', defaults);
    await rt.init(f.ctx);
    const controller = new AbortController();
    const first = rt.save('modelEconomist', { policy: 'economy' });
    const queued = rt.save('modelEconomist', { mode: 'hybrid' }, { signal: controller.signal });
    controller.abort();
    await first;
    await assert.rejects(queued, { name: 'AbortError' });
    const text = await readFile(join(dir, '.pi', 'pi-suite.yaml'), 'utf8');
    assert.match(text, /policy: economy/, 'the earlier save landed');
    assert.match(text, /mode: rules/, 'the aborted save did not');
    await rt.dispose();
  } finally {
    if (old === undefined) delete process.env.PI_SUITE_HOME;
    else process.env.PI_SUITE_HOME = old;
    await rm(dir, { recursive: true, force: true });
  }
});