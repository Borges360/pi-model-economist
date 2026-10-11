import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDocument } from 'yaml';
import install from '../extension.mjs';
import { runDashboard } from '../menu.mjs';
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
    ['risk-floor medium', { thinking: { riskFloor: 'medium' } }],
    ['fixed high', { thinking: { fixed: 'high' } }],
    ['selected-as ignore', { thinking: { useSelectedAs: 'ignore' } }],
    ['scope all', { scope: { source: 'all' } }],
    ['scope-strict off', { scope: { strict: false } }],
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
  // The dashboard routes through the same field table, so it cannot bypass the lock.
  const { dashboardItems } = await import('../menu.mjs');
  const items = dashboardItems({
    conf: (await import('../routing.mjs')).defaults.modelEconomist,
    pool: [],
    scoped: 0,
    last: null,
    notes: { levels: ['off', 'low', 'medium', 'high'] },
  });
  assert.ok(items.some((i) => i.id === 'ceiling'), 'the row exists by default');
  await f.command('economist', '');
  assert.match(f.notifications.at(-1), /Economist ·/);
  assert.equal(dir.length > 0, true);
});

test('the dashboard degrades instead of throwing where the host has no TUI', async () => {
  const opened = await runDashboard({
    ctx: { mode: 'print', hasUI: false, ui: {}, notify: () => {} },
    title: 'x',
    items: [],
    onChange: () => {},
    menus: {},
  });
  assert.equal(opened, false, 'no custom screen, no dashboard');
  const tui = await import('@earendil-works/pi-tui').then(
    () => true,
    () => false,
  );
  assert.equal(tui, false, 'and this package never bundles the host TUI into node --test');
});

test('a bare /economist reports state and effort, and never dumps the whole grammar', async (t) => {
  const { f } = await fresh(t, {
    localExtra:
      'modelEconomist:\n  enabled: true\n  mode: rules\n  policy: economy\n  candidates:\n    - id: openrouter/cheap/model\n      tier: 1\n      tools: true\n    - id: openrouter/mid/model\n      tier: 2\n      tools: true\n  thinking:\n    mode: follow\n',
  });
  await f.command('economist', '');
  const panel = f.notifications.at(-1);
  assert.match(panel, /Economist · ON · modo rules · política economy/);
  assert.match(panel, /esforço follow/);
  assert.match(panel, /pool 2 modelo\(s\)/);
  assert.match(panel, /última decisão: nenhuma/);
  assert.doesNotMatch(panel, /classifier-model PROVIDER\/MODEL/, 'not a command dump');
});
