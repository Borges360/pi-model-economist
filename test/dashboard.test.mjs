import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDocument } from 'yaml';
import install from '../extension.mjs';
import { host, runDashboard } from '../menu.mjs';
import { fakeTui } from '../test-support/fake-tui.mjs';
import { fakePi } from '../test-support/fakes.mjs';

const tick = () => new Promise((r) => setImmediate(r));
const waitForScreen = async (f) => {
  for (let attempt = 0; attempt < 100 && !f.screen; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(f.screen, 'the interactive dashboard opens');
};
/** The dashboard writes through promises the UI never awaits: the drivers below hand
 * back the write promise, so a test awaits the effect instead of counting ticks
 * (tick-counting is the usual source of Windows flack). */
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

const open = async (t, localExtra = '', models = POOL, { trusted = true, globalExtra = '' } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'econ-menu-'));
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  let f;
  t.after(async () => {
    f?.closeScreen?.();
    process.env.PI_SUITE_HOME = old;
    host.tui = undefined;
    host.agent = undefined;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, '.pi'), { recursive: true });
  await writeFile(
    join(dir, '.pi', 'pi-suite.yaml'),
    localExtra || 'modelEconomist: {}\n',
  );
  if (globalExtra) {
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(join(dir, 'state', 'config.yaml'), globalExtra);
  }
  const tui = fakeTui();
  host.tui = tui.tuiPkg;
  host.agent = tui.agentPkg;
  f = fakePi(dir, models);
  f.ctx.isProjectTrusted = () => trusted;
  f.ctx.ui.custom = (factory) =>
    new Promise((resolve) => {
      f.closeScreen = () => resolve({ changed: [] });
      f.screen = factory({ requestRender: () => {} }, tui.theme, tui.keybindings, resolve);
    });
  install(f.pi);
  await f.emit('session_start');
  return { dir, f, tui };
};

const saved = async (dir) =>
  parseDocument(await readFile(join(dir, '.pi', 'pi-suite.yaml'), 'utf8')).toJS();
const poolIds = (c) => c.candidates.map((x) => (typeof x === 'string' ? x : x.id)).sort();
const chooseLanguage = async (settings, tui, locale) => {
  settings.open('language');
  await tui.created.select.at(-1).pick(locale);
};

test('the dashboard stages enum changes until Ctrl+S and stays open after saving', async (t) => {
  const { dir, f, tui } = await open(t);
  const running = f.command('economist', '');
  await waitForScreen(f);
  assert.ok(f.screen, 'a custom screen took over the interactive area');
  const settings = tui.created.settings[0];
  assert.equal(settings.find('language').currentValue, 'English');
  assert.match(f.screen.render(80).join('\n'), /Routing = on/);
  assert.equal(settings.find('thinking').currentValue, 'auto', 'effort routing is the default');
  assert.equal(settings.find('scope').currentValue, 'scoped', 'the scope is the default pool source');

  await settings.cycle('mode', 'rules');
  await settings.cycle('policy', 'economy');
  await settings.cycle('thinking', 'follow');
  await settings.cycle('ceiling', 'xhigh');
  await settings.cycle('cadence', 'session');
  const beforeSave = (await saved(dir)).modelEconomist;
  assert.notEqual(beforeSave.mode, 'rules', 'editing does not persist before an explicit save');
  assert.match(f.screen.render(80).join('\n'), /draft/);
  await f.screen.handleInput('\u0013');
  const savedConf = (await saved(dir)).modelEconomist;
  assert.equal(savedConf.mode, 'rules');
  assert.equal(savedConf.policy, 'economy');
  assert.equal(savedConf.thinking.mode, 'follow');
  assert.equal(savedConf.thinking.ceiling, 'xhigh');
  assert.equal(savedConf.cadence, 'session');
  assert.ok(!f.customResult, 'saving keeps the dashboard open');
  assert.doesNotMatch(f.screen.render(80).join('\n'), /draft/);

  settings.onCancel();
  await running;
  assert.match(f.notifications.at(-1), /5 change\(s\)/, 'the closing summary counts what changed');
});

test('language previews immediately, saves only to the trusted project, and reloads there', async (t) => {
  const globalConfig = 'modelEconomist:\n  locale: pt-BR\n';
  const { dir, f, tui } = await open(t, 'modelEconomist: {}\n', POOL, { globalExtra: globalConfig });
  const running = f.command('economist', '');
  await waitForScreen(f);
  const settings = tui.created.settings[0];
  assert.equal(settings.find('language').currentValue, 'English', 'global locale is ignored');
  assert.match(f.screen.render(80).join('\n'), /Routing = on/);

  await chooseLanguage(settings, tui, 'pt-BR');
  assert.equal(settings.find('language').currentValue, 'Português');
  for (const width of [40, 80, 120]) assert.match(f.screen.render(width).join('\n'), /Roteamento = on/);
  assert.match(f.screen.render(80).join('\n'), /rascunho/);
  assert.equal((await saved(dir)).modelEconomist.locale, undefined, 'preview is not persisted');
  await chooseLanguage(settings, tui, 'en');
  assert.equal(settings.find('language').currentValue, 'English');
  assert.match(f.screen.render(80).join('\n'), /Routing = on/);
  await chooseLanguage(settings, tui, 'pt-BR');

  await f.screen.handleInput('\u0013');
  assert.equal((await saved(dir)).modelEconomist.locale, 'pt-BR');
  assert.equal(await readFile(join(dir, 'state', 'config.yaml'), 'utf8'), globalConfig);
  settings.onCancel();
  await running;

  f.screen = undefined;
  const reopened = f.command('economist', '');
  await waitForScreen(f);
  assert.equal(tui.created.settings.at(-1).find('language').currentValue, 'Português');
  assert.match(f.screen.render(80).join('\n'), /Roteamento = on/);
  tui.created.settings.at(-1).onCancel();
  await reopened;
});

test('an untrusted project can preview language but cannot persist it globally', async (t) => {
  const { dir, f, tui } = await open(t, 'modelEconomist: {}\n', POOL, { trusted: false });
  const running = f.command('economist', '');
  await waitForScreen(f);
  const settings = tui.created.settings[0];
  await chooseLanguage(settings, tui, 'pt-BR');
  assert.match(f.screen.render(80).join('\n'), /Roteamento = on/);
  await f.screen.handleInput('\u0013');
  assert.match(f.notifications.at(-1), /projeto confiável/);
  assert.equal((await saved(dir)).modelEconomist.locale, undefined);
  await assert.rejects(readFile(join(dir, 'state', 'config.yaml')));
  assert.match(f.screen.render(80).join('\n'), /rascunho/);
  f.screen.handleInput('\u001b');
  f.screen.handleInput('\u001b');
  await running;
});

test('project locale does not leak when the active project changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'econ-project-locale-'));
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(root, 'state');
  t.after(async () => {
    process.env.PI_SUITE_HOME = old;
    host.tui = undefined;
    host.agent = undefined;
    await rm(root, { recursive: true, force: true });
  });

  const firstProject = join(root, 'first');
  const secondProject = join(root, 'second');
  await mkdir(join(firstProject, '.pi'), { recursive: true });
  await mkdir(join(secondProject, '.pi'), { recursive: true });
  await mkdir(join(root, 'state'), { recursive: true });
  await writeFile(join(firstProject, '.pi', 'pi-suite.yaml'), 'modelEconomist:\n  locale: pt-BR\n');
  await writeFile(join(secondProject, '.pi', 'pi-suite.yaml'), 'modelEconomist: {}\n');
  await writeFile(join(root, 'state', 'config.yaml'), 'modelEconomist:\n  locale: pt-BR\n');

  const tui = fakeTui();
  host.tui = tui.tuiPkg;
  host.agent = tui.agentPkg;
  const f = fakePi(firstProject, POOL);
  f.ctx.ui.custom = (factory) => new Promise((resolve) => {
    f.closeScreen = () => resolve({ changed: [] });
    f.screen = factory({ requestRender: () => {} }, tui.theme, tui.keybindings, resolve);
  });
  install(f.pi);
  await f.emit('session_start');
  let running = f.command('economist', '');
  await waitForScreen(f);
  assert.equal(tui.created.settings.at(-1).find('language').currentValue, 'Português');
  tui.created.settings.at(-1).onCancel();
  await running;

  f.screen = undefined;
  f.ctx.cwd = secondProject;
  await f.emit('session_start');
  running = f.command('economist', '');
  await waitForScreen(f);
  assert.equal(tui.created.settings.at(-1).find('language').currentValue, 'English');
  assert.match(f.screen.render(80).join('\n'), /Routing = on/);
  tui.created.settings.at(-1).onCancel();
  await running;
});

test('pool edits stay in the draft until Ctrl+S', async (t) => {
  const { dir, f, tui } = await open(
    t,
    'modelEconomist:\n  candidates:\n    - id: openrouter/cheap/model\n      tier: 1\n      tools: true\n    - id: openrouter/mid/model\n      tier: 2\n      tools: true\n',
  );
  const running = f.command('economist', '');
  await waitForScreen(f);
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
  assert.equal(settings.find('poolEdit'), undefined, 'editing happens inside the pool');
  await editSelect.pick('tier:4');
  assert.equal(
    (await saved(dir)).modelEconomist.candidates.find((c) => c.id === 'openrouter/mid/model').tier,
    2,
    'pool edits do not persist before save',
  );

  assert.equal(settings.find('poolAdd'), undefined);
  await tui.created.select.at(-1).pick('openrouter/cheap/model');
  await tui.created.select.at(-1).pick('tools:off');
  const afterTools = (await saved(dir)).modelEconomist;
  assert.equal(afterTools.candidates.find((c) => c.id === 'openrouter/cheap/model').tools, true);
  await tui.created.select.at(-1).pick('openrouter/cheap/model');
  await tui.created.select.at(-1).pick('remove');
  assert.deepEqual(poolIds((await saved(dir)).modelEconomist), ['openrouter/cheap/model', 'openrouter/mid/model']);
  await f.screen.handleInput('\u0013');
  assert.deepEqual(poolIds((await saved(dir)).modelEconomist), ['openrouter/mid/model']);
  settings.onCancel();
  await running;
});

test('a failed save preserves the draft and the effective configuration for retry', async (t) => {
  const { dir, f, tui } = await open(t);
  const running = f.command('economist', '');
  await waitForScreen(f);
  const settings = tui.created.settings[0];
  await settings.cycle('mode', 'rules');
  const original = (await saved(dir)).modelEconomist;
  const effectiveModel = f.ctx.model;

  // Route this one save to a directory at the config-file path so the atomic
  // reader rejects it. This is confined to the disposable test fixture.
  const blockedTarget = join(dir, 'state', 'config.yaml');
  await mkdir(blockedTarget, { recursive: true });
  f.ctx.isProjectTrusted = () => false;
  await f.screen.handleInput('\u0013');
  assert.equal((await saved(dir)).modelEconomist.mode, original.mode);
  assert.match(f.screen.render(80).join('\n'), /draft/);
  assert.match(f.notifications.at(-1), /Save failed/);
  assert.equal(f.ctx.model, effectiveModel, 'a failed write does not switch the active model');

  f.ctx.isProjectTrusted = () => true;
  await rm(blockedTarget, { recursive: true, force: true });
  await f.screen.handleInput('\u0013');
  assert.equal((await saved(dir)).modelEconomist.mode, 'rules');
  assert.doesNotMatch(f.screen.render(80).join('\n'), /draft/);
  settings.onCancel();
  await running;
});

test('Esc in a submenu returns to the draft; root Esc warns and then discards', async (t) => {
  const { dir, f, tui } = await open(t);
  const running = f.command('economist', '');
  await waitForScreen(f);
  const settings = tui.created.settings[0];
  await settings.cycle('mode', 'rules');
  const originalMode = (await saved(dir)).modelEconomist.mode;
  settings.open('help');
  settings.top().handleInput('\u001b');
  assert.ok(!f.customResult, 'Esc from the submenu returns to the dashboard');
  assert.match(f.screen.render(80).join('\n'), /draft/);
  assert.notEqual((await saved(dir)).modelEconomist.mode, 'rules');

  f.screen.handleInput('\u001b');
  assert.ok(!f.customResult, 'the first root Esc warns instead of discarding');
  assert.match(f.notifications.at(-1), /Esc again to discard/);
  f.screen.handleInput('\u001b');
  await running;
  assert.equal((await saved(dir)).modelEconomist.mode, originalMode);
  assert.match(f.notifications.at(-1), /draft|no changes/i);
});

test('simulation refuses unsaved drafts instead of evaluating them', async (t) => {
  const { dir, f, tui } = await open(t);
  const running = f.command('economist', '');
  await waitForScreen(f);
  const settings = tui.created.settings[0];
  await settings.cycle('mode', 'rules');
  settings.open('simulate');
  const input = tui.created.input.at(-1);
  await input.submit('refatorar autenticação');
  assert.match(settings.top().render(80).join('\n'), /Save or discard the draft/);
  assert.notEqual((await saved(dir)).modelEconomist.mode, 'rules');
  settings.top().handleInput('\u001b');
  f.screen.handleInput('\u001b');
  f.screen.handleInput('\u001b');
  await running;
});

test('the dashboard renders without models or providers and keeps Unicode across terminal widths', async (t) => {
  const { f, tui } = await open(t, '', []);
  const running = f.command('economist', '');
  await waitForScreen(f);
  assert.ok(f.screen, 'the dashboard opens without a model catalogue');
  for (const width of [40, 80, 120]) {
    const rendered = f.screen.render(width).join('\n');
    assert.match(rendered, /Economist/);
    assert.match(rendered, /·/);
  }
  const settings = tui.created.settings[0];
  f.screen.handleInput('\u001b');
  await running;
});

test('a cancelled in-flight simulation aborts and ignores its late callback', async (t) => {
  const { f, tui } = await open(t);
  let signal;
  let resolveSimulation;
  const items = [{ id: 'simulate', label: 'Simular', currentValue: 'abrir', submenu: true }];
  const running = runDashboard({
    ctx: f.ctx,
    title: 'Economist · ação',
    items,
    onChange: async () => undefined,
    onSave: async () => null,
    isDirty: () => false,
    onDiscard: () => {},
    menus: {
      pool: () => [],
      candidateRows: () => [],
      explain: () => [],
      help: () => [],
      simulate: (_text, options) => new Promise((resolve) => {
        signal = options.signal;
        resolveSimulation = resolve;
      }),
    },
  }, { tuiPkg: tui.tuiPkg, agentPkg: tui.agentPkg });
  await waitForScreen(f);
  const settings = tui.created.settings[0];
  const root = f.screen;
  for (const width of [40, 80, 120]) assert.match(root.render(width).join('\n'), /ação/);
  settings.open('simulate');
  const pending = tui.created.input.at(-1).submit('pedido com ação');
  await tick();
  assert.ok(signal && !signal.aborted, 'the simulation receives a live cancellation signal');
  settings.top().handleInput('\u001b');
  assert.equal(signal.aborted, true, 'Esc cancels the pending operation');
  settings.top().handleInput('\u001b');
  root.handleInput('\u001b');
  await running;
  resolveSimulation(['resultado atrasado que não pode aparecer']);
  await pending;
  assert.doesNotMatch(root.render(80).join('\n'), /resultado atrasado/);
});

test('the simulate panel routes a turn for free and esc leaves the dashboard open', async (t) => {
  const { f, tui } = await open(
    t,
    'modelEconomist:\n  mode: rules\n  candidates:\n    - id: openrouter/cheap/model\n      tier: 1\n      tools: true\n    - id: openrouter/mid/model\n      tier: 3\n      tools: true\n',
  );
  const running = f.command('economist', '');
  await waitForScreen(f);
  const settings = tui.created.settings[0];

  settings.open('simulate');
  const screen = settings.top();
  // Keys reach the component, exactly as the terminal delivers them.
  for (const ch of 'olá') screen.handleInput(ch);
  await screen.handleInput('\r');
  const lines = screen.render(80).join('\n');
  assert.match(lines, /openrouter\/cheap\/model/, 'the dry run names the model it would use');
  assert.match(lines, /effort selected by/, 'and the effort it would dispatch');
  assert.equal(tui.created.settings.length, 1, 'simulate never rebuilt the dashboard');
  assert.equal(tui.created.input.length, 1, 'one input, reused');

  screen.handleInput('\u001b'); // esc once: back to the main screen
  assert.ok(!f.customResult, 'the dashboard is still open');
  settings.onCancel();
  await running;
  assert.match(f.notifications.at(-1), /no changes/i);
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
  await waitForScreen(f);
  const settings = tui.created.settings[0];
  assert.match(settings.find('explain').currentValue, /cheap\/model:off/);
  settings.open('explain');
  assert.match(settings.top().render(80).join('\n'), /model \+ effort: openrouter\/cheap\/model:off/);
  settings.onCancel();
  await running;
});
