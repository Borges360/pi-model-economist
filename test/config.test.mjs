import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../lib/core.mjs';
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
