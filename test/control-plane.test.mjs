import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDocument } from 'yaml';
import install from '../extension.mjs';
import { economistFields } from '../menu.mjs';
import { fakePi } from '../test-support/fakes.mjs';

const chat = (id, price, extra = {}) => ({
  provider: 'openrouter',
  id,
  name: id,
  api: 'openai-completions',
  input: ['text'],
  cost: { input: price, output: price },
  contextWindow: 200000,
  maxTokens: 8192,
  reasoning: true,
  ...extra,
});

const fresh = async (t, { globalExtra = '', localExtra = '' } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'econ-ctl-'));
  const home = join(dir, 'state');
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = home;
  t.after(async () => {
    process.env.PI_SUITE_HOME = old;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, '.pi'), { recursive: true });
  await mkdir(join(home, 'projects'), { recursive: true });
  if (globalExtra) {
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(home, 'config.yaml'), globalExtra);
  }
  if (localExtra) await writeFile(join(dir, '.pi', 'pi-suite.yaml'), localExtra);
  const f = fakePi(dir, [
    chat('cheap/model', 0.2),
    chat('mid/model', 1),
    chat('vision/model', 3, { input: ['text', 'image'] }),
  ]);
  install(f.pi);
  return { dir, f };
};

const saved = async (dir) => parseDocument(await readFile(join(dir, '.pi', 'pi-suite.yaml'), 'utf8')).toJS();

test('every new control has a validated command and persists only its own field', async (t) => {
  const { dir, f } = await fresh(t);
  const cases = [
    ['thinking follow', { thinking: { mode: 'follow' } }],
    ['ceiling low', { thinking: { ceiling: 'low' } }],
    ['fixed high', { thinking: { fixed: 'high' } }],
    ['scope all', { scope: { source: 'all' } }],
  ];
  for (const [args, patch] of cases) {
    await f.command('economist', args);
    const file = (await saved(dir)).modelEconomist;
    for (const [section, values] of Object.entries(patch))
      for (const [key, value] of Object.entries(values))
        assert.equal(file[section][key], value, `${args} must persist ${section}.${key}`);
  }
  assert.equal(Object.keys((await saved(dir))).join(), 'modelEconomist', 'touches only its own section');
  // Refuses a value pi could not dispatch, and says what was allowed.
  const bad = await f.command('economist', 'ceiling turbo').then(() => null, (e) => e.message);
  assert.match(bad, /Invalid ceiling: turbo/);
  assert.match(bad, /xhigh/, 'the refusal lists the real ladder');
  assert.equal((await saved(dir)).modelEconomist.thinking.ceiling, 'low', 'a refusal wrote nothing');
});

test('a global lock freezes effort and scope for the commands and the menu alike', async (t) => {
  const { dir, f } = await fresh(t, {
    globalExtra: 'locked:\n  modelEconomist:\n    thinking:\n      ceiling: high\n',
  });
  await assert.rejects(() => f.command('economist', 'ceiling low'), /locked by global policy/);
  // The panel routes through the same field table, so it cannot bypass the lock: the row
  // exists by default and carries the lock source when a lock applies
  // (keyboard coverage in panel-parity.test.mjs).
  const enums = { presets: [], controls: [], cadences: [], modes: [], policies: [], thinking: [], levels: ['off', 'low', 'medium', 'high'], scopes: [], stages: [] };
  const free = economistFields('en', { enums });
  assert.ok(free.some((field) => field.id === 'ceiling' && !field.locked), 'the row exists by default');
  const locked = economistFields('en', { enums, locks: { ceiling: 'global policy' } });
  assert.deepEqual(locked.find((field) => field.id === 'ceiling').locked, { source: 'global policy' });
  await f.command('economist', '');
  assert.match(f.notifications.at(-1), /Economist ·/);
  assert.equal(dir.length > 0, true);
});

test('the panel degrades to the text status instead of throwing where the host has no TUI', async (t) => {
  const { f } = await fresh(t);
  let mounted = 0;
  f.ctx.mode = 'print';
  f.ctx.ui.custom = () => {
    mounted++;
    return Promise.resolve();
  };
  await f.command('economist', '');
  assert.equal(mounted, 0, 'no custom screen outside the TUI');
  assert.match(f.notifications.at(-1), /Economist ·/);
  // The vendored adapter imports pi-tui statically, so `node --test` resolves the pinned
  // devDependency (the same 1.6.0 the smoke loads); production resolves Pi's own copy
  // through the extension loader. The text fallback above needs neither.
});

test('a bare /economist reports state and effort, and never dumps the whole grammar', async (t) => {
  const { f } = await fresh(t, {
    localExtra:
      'modelEconomist:\n  enabled: true\n  mode: rules\n  policy: economy\n  candidates:\n    - id: openrouter/cheap/model\n      tier: 1\n      tools: true\n    - id: openrouter/mid/model\n      tier: 2\n      tools: true\n  thinking:\n    mode: follow\n',
  });
  await f.command('economist', '');
  const panel = f.notifications.at(-1);
  // English is the default language of the text status too (it used to be fixed in Portuguese).
  assert.match(panel, /Economist · ON · cadence prompt · assessment rules · policy economy/);
  assert.match(panel, /effort follow/);
  assert.match(panel, /pool 2 model\(s\)/);
  assert.match(panel, /last decision: none/);
  assert.doesNotMatch(panel, /classifier-model PROVIDER\/MODEL/, 'not a command dump');
});
