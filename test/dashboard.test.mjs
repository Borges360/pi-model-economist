import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDocument } from 'yaml';
import install from '../extension.mjs';
import { host } from '../menu.mjs';
import { fakeTui } from '../test-support/fake-tui.mjs';
import { fakePi } from '../test-support/fakes.mjs';

const tick = () => new Promise((r) => setImmediate(r));
/** The dashboard writes through promises the UI never awaits: give them room. */
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1));
};
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
const POOL = [
  chat('cheap/model', 0.2),
  chat('mid/model', 1),
  chat('vision/model', 3, { input: ['text', 'image'] }),
];

const open = async (t, localExtra = '') => {
  const dir = await mkdtemp(join(tmpdir(), 'econ-menu-'));
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  t.after(async () => {
    process.env.PI_SUITE_HOME = old;
    host.tui = undefined;
    host.agent = undefined;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, '.pi'), { recursive: true });
  if (localExtra) await writeFile(join(dir, '.pi', 'pi-suite.yaml'), localExtra);
  const tui = fakeTui();
  host.tui = tui.tuiPkg;
  host.agent = tui.agentPkg;
  const f = fakePi(dir, POOL);
  f.ctx.ui.custom = (factory) =>
    new Promise((resolve) => {
      f.screen = factory({ requestRender: () => {} }, tui.theme, tui.keybindings, resolve);
    });
  install(f.pi);
  await f.emit('session_start');
  return { dir, f, tui };
};

const saved = async (dir) =>
  parseDocument(await readFile(join(dir, '.pi', 'pi-suite.yaml'), 'utf8')).toJS();
const poolIds = (c) => c.candidates.map((x) => (typeof x === 'string' ? x : x.id)).sort();

test('the dashboard opens on a bare /economist and applies enum changes as they are made', async (t) => {
  const { dir, f, tui } = await open(t);
  const running = f.command('economist', '');
  await tick();
  assert.ok(f.screen, 'a custom screen took over the interactive area');
  const settings = tui.created.settings[0];
  assert.equal(settings.find('thinking').currentValue, 'auto', 'effort routing is the default');
  assert.equal(settings.find('scope').currentValue, 'scoped', 'the scope is the default pool source');

  await settings.cycle('mode', 'rules');
  await settings.cycle('policy', 'economy');
  await settings.cycle('thinking', 'follow');
  await settings.cycle('ceiling', 'xhigh');
  await settings.cycle('scope-strict', 'off');
  const savedConf = (await saved(dir)).modelEconomist;
  assert.equal(savedConf.mode, 'rules');
  assert.equal(savedConf.policy, 'economy');
  assert.equal(savedConf.thinking.mode, 'follow');
  assert.equal(savedConf.thinking.ceiling, 'xhigh');
  assert.equal(savedConf.scope.strict, false);

  settings.onCancel();
  await running;
  assert.match(f.notifications.at(-1), /5 mudança\(s\)/, 'the closing summary counts what changed');
});

test('pool editing reaches the config through submenu navigation', async (t) => {
  const { dir, f, tui } = await open(
    t,
    'modelEconomist:\n  candidates:\n    - id: openrouter/cheap/model\n      tier: 1\n      tools: true\n    - id: openrouter/mid/model\n      tier: 2\n      tools: true\n',
  );
  const running = f.command('economist', '');
  await tick();
  const settings = tui.created.settings[0];

  settings.open('pool');
  const poolSelect = tui.created.select.at(-1);
  assert.deepEqual(poolSelect.items.map((i) => i.value), [
    'openrouter/cheap/model',
    'openrouter/mid/model',
  ]);
  poolSelect.pick('openrouter/mid/model');
  const editSelect = tui.created.select.at(-1);
  assert.ok(editSelect.items.some((i) => i.value === 'tier:4'), 'the edit screen offers tiers');
  assert.equal(settings.find('poolEdit').currentValue, 'openrouter/mid/model', 'it knows which model');
  await editSelect.pick('tier:4');
  assert.equal(
    (await saved(dir)).modelEconomist.candidates.find((c) => c.id === 'openrouter/mid/model').tier,
    4,
  );

  settings.open('poolAdd');
  const addSelect = tui.created.select.at(-1);
  assert.deepEqual(addSelect.items.map((i) => i.value), ['openrouter/vision/model']);
  await addSelect.pick('openrouter/vision/model');
  assert.deepEqual(poolIds((await saved(dir)).modelEconomist), [
    'openrouter/cheap/model',
    'openrouter/mid/model',
    'openrouter/vision/model',
  ]);

  settings.open('pool');
  await tui.created.select.at(-1).pick('openrouter/cheap/model');
  await tui.created.select.at(-1).pick('tools:off');
  const afterTools = (await saved(dir)).modelEconomist;
  assert.equal(afterTools.candidates.find((c) => c.id === 'openrouter/cheap/model').tools, false);
  settings.open('pool');
  await tui.created.select.at(-1).pick('openrouter/cheap/model');
  await tui.created.select.at(-1).pick('remove');
  assert.deepEqual(poolIds((await saved(dir)).modelEconomist), [
    'openrouter/mid/model',
    'openrouter/vision/model',
  ]);
  settings.onCancel();
  await running;
});

test('the simulate panel routes a turn for free and esc leaves the dashboard open', async (t) => {
  const { f, tui } = await open(
    t,
    'modelEconomist:\n  mode: rules\n  candidates:\n    - id: openrouter/cheap/model\n      tier: 1\n      tools: true\n    - id: openrouter/mid/model\n      tier: 3\n      tools: true\n',
  );
  const running = f.command('economist', '');
  await tick();
  const settings = tui.created.settings[0];

  settings.open('simulate');
  const screen = settings.top();
  // Keys reach the component, exactly as the terminal delivers them.
  for (const ch of 'olá') screen.handleInput(ch);
  screen.handleInput('\r');
  await settle(12);
  const lines = screen.render(80).join('\n');
  assert.match(lines, /openrouter\/cheap\/model/, 'the dry run names the model it would use');
  assert.match(lines, /esforço definido por/, 'and the effort it would dispatch');
  assert.equal(tui.created.settings.length, 1, 'simulate never rebuilt the dashboard');
  assert.equal(tui.created.input.length, 1, 'one input, reused');

  screen.handleInput('\u001b'); // esc once: back to the main screen
  assert.ok(!f.customResult, 'the dashboard is still open');
  settings.onCancel();
  await running;
  assert.match(f.notifications.at(-1), /nenhuma alteração|nada foi alterado|0 mudança/);
});

test('the explain panel quotes the last real decision', async (t) => {
  const { f, tui } = await open(
    t,
    'modelEconomist:\n  mode: rules\n  enabled: true\n  candidates:\n    - id: openrouter/cheap/model\n      tier: 1\n      tools: true\n',
  );
  await f.pi.virtual.route(
    { reason: 'user', messages: [{ role: 'user', content: 'olá' }], thinkingLevel: 'off' },
    f.ctx,
  );
  const running = f.command('economist', '');
  await tick();
  const settings = tui.created.settings[0];
  assert.match(settings.find('explain').currentValue, /cheap\/model:off/);
  settings.open('explain');
  assert.match(settings.top().render(80).join('\n'), /modelo \+ esforço: openrouter\/cheap\/model:off/);
  settings.onCancel();
  await running;
});
