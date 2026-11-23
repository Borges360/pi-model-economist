/**
 * The `/economist` panel, driven the way a terminal drives it: key bytes (↑ ↓ Enter
 * Ctrl+S Esc) into the real vendored Pi adapter, with the real pi-tui keybindings and
 * width measure. No model is called and nothing is paid: simulations are dry runs.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDocument } from 'yaml';
import install from '../extension.mjs';
import { host, openPiSettings, simulationScreen } from '../menu.mjs';
import { fakePi } from '../test-support/fakes.mjs';
import { attachScreens, waitForScreen, press, type, focus, choose, view, KEY } from '../test-support/panel.mjs';

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
const TWO =
  'modelEconomist:\n  candidates:\n    - id: openrouter/cheap/model\n      tier: 1\n      tools: true\n    - id: openrouter/mid/model\n      tier: 2\n      tools: true\n';

const open = async (t, localExtra = '', models = POOL, { trusted = true, globalExtra = '', rows = 40 } = {}) => {
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
  await writeFile(join(dir, '.pi', 'pi-suite.yaml'), localExtra || 'modelEconomist: {}\n');
  if (globalExtra) {
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(join(dir, 'state', 'config.yaml'), globalExtra);
  }
  const f = fakePi(dir, models);
  f.ctx.isProjectTrusted = () => trusted;
  const screens = attachScreens(f.ctx, { rows });
  install(f.pi);
  await f.emit('session_start');
  return { dir, f, screens };
};

const saved = async (dir) =>
  parseDocument(await readFile(join(dir, '.pi', 'pi-suite.yaml'), 'utf8')).toJS();
const poolIds = (c) => c.candidates.map((x) => (typeof x === 'string' ? x : x.id)).sort();
/** Words that only exist in the Portuguese catalogs (product and adapter). */
const PORTUGUESE = /ção|ções|ões|Idioma|Roteamento|ligado|desligado|Salvar|Fechar|Ajuda|Alterações|Buscar|navegar|Prioridade|Pedido/;

test('the panel stages changes until Ctrl+S and stays open after saving', async (t) => {
  const { dir, f, screens } = await open(t);
  const running = f.command('economist', '');
  const screen = await waitForScreen(screens);
  const panel = screen.component;
  assert.equal(screen.options.overlay, true, 'the panel is a temporary overlay, not an editor/footer replacement');
  const first = view(panel, 80);
  assert.match(first, /^Economist$/m);
  assert.match(first, /Language\s+English/);
  assert.match(first, /Routing\s+on/);
  assert.match(first, /Effort \(thinking\)\s+auto/, 'effort routing is the default');
  assert.match(first, /Pool source\s+\/scoped-models only/, 'the scope is the default pool source');
  assert.match(first, /↑↓ navigate · Enter edit\/open · Ctrl\+S save/);

  await choose(panel, 'mode', 'rules');
  await choose(panel, 'policy', 'economy');
  await choose(panel, 'thinking', 'follow');
  await choose(panel, 'ceiling', 'xhigh');
  await choose(panel, 'cadence', 'session');
  assert.notEqual((await saved(dir)).modelEconomist.mode, 'rules', 'editing does not persist before an explicit save');
  assert.match(view(panel, 80), /^Economist \*$/m, 'the title marks the draft');
  assert.match(view(panel, 80), /Unsaved changes/);

  await press(panel, KEY.ctrlS);
  const file = (await saved(dir)).modelEconomist;
  assert.equal(file.mode, 'rules');
  assert.equal(file.policy, 'economy');
  assert.equal(file.thinking.mode, 'follow');
  assert.equal(file.thinking.ceiling, 'xhigh');
  assert.equal(file.cadence, 'session');
  assert.equal(screen.closed, false, 'saving keeps the panel open');
  const after = view(panel, 80);
  assert.match(after, /^Economist$/m, 'no draft marker after the save');
  assert.match(after, /Settings saved to/);
  assert.match(after, /pi-suite\.yaml/);

  await press(panel, KEY.esc);
  await running;
  assert.equal(screen.closed, true);
  assert.match(f.notifications.at(-1), /5 change\(s\)/, 'the closing summary counts what changed');
  assert.match(f.notifications.at(-1), /How to assess a task: hybrid → rules/);
});

test('language previews immediately, saves only to the trusted project, and reloads there', async (t) => {
  const globalConfig = 'modelEconomist:\n  locale: pt-BR\n';
  const { dir, f, screens } = await open(t, 'modelEconomist: {}\n', POOL, { globalExtra: globalConfig });
  const running = f.command('economist', '');
  const panel = (await waitForScreen(screens)).component;
  const english = view(panel, 120);
  assert.match(english, /Language\s+English/, 'the global locale is ignored');
  assert.doesNotMatch(english, PORTUGUESE, 'no Portuguese string in the English panel');

  await choose(panel, 'language', 'pt-BR');
  for (const width of [40, 80, 120]) {
    const text = view(panel, width);
    assert.match(text, /Idioma/);
    assert.match(text, /Roteamento/);
    assert.match(text, /Salvar/, 'the adapter texts switch too');
  }
  assert.match(view(panel, 120), /Idioma\s+Português/);
  assert.match(view(panel, 80), /Alterações não salvas/);
  assert.doesNotMatch(view(panel, 120), /Save changes|Unsaved changes|Routing\b/, 'no English left in the Portuguese preview');
  assert.equal((await saved(dir)).modelEconomist.locale, undefined, 'the preview is not persisted');
  await choose(panel, 'language', 'en');
  assert.match(view(panel, 80), /Language\s+English/);
  await choose(panel, 'language', 'pt-BR');

  await press(panel, KEY.ctrlS);
  assert.equal((await saved(dir)).modelEconomist.locale, 'pt-BR');
  assert.equal(await readFile(join(dir, 'state', 'config.yaml'), 'utf8'), globalConfig, 'the global file is untouched');
  assert.match(view(panel, 80), /Configurações salvas em/);
  await press(panel, KEY.esc);
  await running;

  const reopened = f.command('economist', '');
  const again = (await waitForScreen(screens, 2)).component;
  assert.match(view(again, 120), /Idioma\s+Português/);
  assert.match(view(again, 120), /Roteamento\s+ligado/);
  await press(again, KEY.esc);
  await reopened;
});

test('discarding a language preview goes back to the saved language', async (t) => {
  const { dir, f, screens } = await open(t);
  const running = f.command('economist', '');
  const panel = (await waitForScreen(screens)).component;
  await choose(panel, 'language', 'pt-BR');
  assert.match(view(panel, 80), /Idioma/);
  await press(panel, KEY.esc);
  assert.match(view(panel, 80), /Há alterações não salvas/);
  await press(panel, KEY.esc);
  await running;
  assert.equal((await saved(dir)).modelEconomist.locale, undefined);
  assert.match(f.notifications.at(-1), /no changes/i, 'the summary is in the saved language');
});

test('an untrusted project shows the language as locked and writes nothing', async (t) => {
  const { dir, f, screens } = await open(t, 'modelEconomist: {}\n', POOL, { trusted: false });
  const running = f.command('economist', '');
  const panel = (await waitForScreen(screens)).component;
  assert.match(view(panel, 120), /Language\s+English\s+\[locked: untrusted project\]/);
  await focus(panel, 'language');
  await press(panel, KEY.enter);
  assert.match(view(panel, 120), /Locked by untrusted project/);
  assert.equal(panel.controller.session.editing, undefined, 'no editor opens on a locked field');
  assert.equal(panel.controller.session.dirty, false);
  assert.equal((await saved(dir)).modelEconomist.locale, undefined);
  await assert.rejects(readFile(join(dir, 'state', 'config.yaml')), 'nothing is written globally');
  await press(panel, KEY.esc);
  await running;
});

test('project locale does not leak when the active project changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'econ-project-locale-'));
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(root, 'state');
  t.after(async () => {
    process.env.PI_SUITE_HOME = old;
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

  const f = fakePi(firstProject, POOL);
  const screens = attachScreens(f.ctx);
  install(f.pi);
  await f.emit('session_start');
  let running = f.command('economist', '');
  let panel = (await waitForScreen(screens)).component;
  assert.match(view(panel, 120), /Idioma\s+Português/);
  await press(panel, KEY.esc);
  await running;

  f.ctx.cwd = secondProject;
  await f.emit('session_start');
  running = f.command('economist', '');
  panel = (await waitForScreen(screens, 2)).component;
  assert.match(view(panel, 120), /Language\s+English/);
  assert.match(view(panel, 120), /Routing\s+on/);
  await press(panel, KEY.esc);
  await running;
});

test('pool edits stay in their own draft until Ctrl+S, and the pool waits for a saved main draft', async (t) => {
  const { dir, f, screens } = await open(t, TWO);
  const running = f.command('economist', '');
  const main = (await waitForScreen(screens)).component;
  assert.match(view(main, 120), /Candidate pool\s+2 model\(s\)/);

  // A dirty main draft is never silently dropped by leaving for the pool.
  await choose(main, 'mode', 'rules');
  await focus(main, 'pool');
  await press(main, KEY.enter);
  assert.equal(screens.screens.length, 1, 'the pool does not open over an unsaved draft');
  assert.match(view(main, 120), /Save \(Ctrl\+S\) or discard your changes/);
  await choose(main, 'mode', 'hybrid');
  assert.equal(main.controller.session.dirty, false);

  await focus(main, 'pool');
  await press(main, KEY.enter);
  const poolScreen = await waitForScreen(screens, 2);
  const pool = poolScreen.component;
  const listed = view(pool, 120);
  assert.match(listed, /Economist · candidate pool/);
  assert.match(listed, /cheap\/model · in pool\s+on/);
  assert.match(listed, /mid\/model · tier\s+tier 2/);

  await choose(pool, 'tier:openrouter/mid/model', '4');
  assert.equal(
    (await saved(dir)).modelEconomist.candidates.find((c) => c.id === 'openrouter/mid/model').tier,
    2,
    'pool edits do not persist before save',
  );
  await focus(pool, 'tools:openrouter/cheap/model');
  await press(pool, KEY.enter);
  assert.equal((await saved(dir)).modelEconomist.candidates.find((c) => c.id === 'openrouter/cheap/model').tools, true);
  await focus(pool, 'member:openrouter/cheap/model');
  await press(pool, KEY.enter);
  assert.deepEqual(poolIds((await saved(dir)).modelEconomist), ['openrouter/cheap/model', 'openrouter/mid/model']);

  await press(pool, KEY.ctrlS);
  const file = (await saved(dir)).modelEconomist;
  assert.deepEqual(poolIds(file), ['openrouter/mid/model']);
  assert.equal(file.candidates[0].tier, 4);
  assert.equal(poolScreen.closed, false, 'saving keeps the pool open');

  await press(pool, KEY.esc);
  const back = (await waitForScreen(screens, 3)).component;
  assert.match(view(back, 120), /Candidate pool\s+1 model\(s\)/, 'Esc returns to the main panel with the new pool');
  await press(back, KEY.esc);
  await running;
  assert.match(f.notifications.at(-1), /change\(s\)/);
});

test('a failed save keeps the draft and the active model, and a retry saves it', async (t) => {
  const { dir, f, screens } = await open(t);
  const running = f.command('economist', '');
  const panel = (await waitForScreen(screens)).component;
  await choose(panel, 'mode', 'rules');
  const original = (await saved(dir)).modelEconomist;
  const effectiveModel = f.ctx.model;

  // Route this one save to a directory at the config-file path so the atomic
  // reader rejects it. This is confined to the disposable test fixture.
  const blockedTarget = join(dir, 'state', 'config.yaml');
  await mkdir(blockedTarget, { recursive: true });
  f.ctx.isProjectTrusted = () => false;
  await press(panel, KEY.ctrlS);
  assert.equal((await saved(dir)).modelEconomist.mode, original.mode);
  const failed = view(panel, 120);
  assert.match(failed, /Save failed; the draft was kept/);
  assert.match(failed, /^Economist \*$/m, 'the draft is still there');
  assert.match(failed, /How to assess a task\s+rules/);
  assert.equal(f.ctx.model, effectiveModel, 'a failed write does not switch the active model');

  f.ctx.isProjectTrusted = () => true;
  await rm(blockedTarget, { recursive: true, force: true });
  await press(panel, KEY.ctrlS);
  assert.equal((await saved(dir)).modelEconomist.mode, 'rules');
  assert.match(view(panel, 80), /^Economist$/m);
  await press(panel, KEY.esc);
  await running;
});

test('Esc in an editor returns without applying; root Esc warns and a second Esc discards', async (t) => {
  const { dir, f, screens } = await open(t);
  const running = f.command('economist', '');
  const screen = await waitForScreen(screens);
  const panel = screen.component;
  await choose(panel, 'mode', 'rules');
  const before = (await saved(dir)).modelEconomist;
  const policy = panel.controller.session.draft.policy;

  await focus(panel, 'policy');
  await press(panel, KEY.enter, KEY.down);
  assert.ok(panel.controller.session.editing, 'the choice list is open');
  await press(panel, KEY.esc);
  assert.equal(panel.controller.session.editing, undefined, 'Esc closed the list');
  assert.equal(panel.controller.session.draft.policy, policy, 'the incomplete edit was not applied');
  assert.equal(screen.closed, false);

  await press(panel, KEY.esc);
  assert.equal(screen.closed, false, 'the first root Esc warns instead of discarding');
  const warning = view(panel, 80);
  assert.match(warning, /There are unsaved changes/);
  assert.match(warning, /Press Esc again to discard/);
  await press(panel, KEY.esc);
  await running;
  assert.equal(screen.closed, true);
  assert.equal((await saved(dir)).modelEconomist.mode, before.mode);
  assert.match(f.notifications.at(-1), /no changes/i);
});

test('the simulation waits for a saved draft and then routes a request for free', async (t) => {
  const { f, screens } = await open(
    t,
    'modelEconomist:\n  mode: rules\n  candidates:\n    - id: openrouter/cheap/model\n      tier: 1\n      tools: true\n    - id: openrouter/mid/model\n      tier: 3\n      tools: true\n',
  );
  const running = f.command('economist', '');
  const main = (await waitForScreen(screens)).component;
  await choose(main, 'policy', 'quality');
  await focus(main, 'simulate');
  await press(main, KEY.enter);
  assert.equal(screens.screens.length, 1, 'simulation never evaluates an unsaved draft');
  assert.match(view(main, 120), /Save \(Ctrl\+S\) or discard your changes/);
  await choose(main, 'policy', 'balanced');

  await focus(main, 'simulate');
  await press(main, KEY.enter);
  const simulate = (await waitForScreen(screens, 2)).component;
  assert.match(view(simulate, 120), /Run simulation\s+\[unavailable: Enter a request to simulate\.\]/);
  await focus(simulate, 'request');
  await press(simulate, KEY.enter);
  await type(simulate, 'olá');
  await press(simulate, KEY.enter);
  await focus(simulate, 'run');
  await press(simulate, KEY.enter);

  const result = (await waitForScreen(screens, 3)).component;
  const lines = view(result, 120);
  assert.match(lines, /Economist · simulation result/);
  assert.match(lines, /openrouter\/cheap\/model/, 'the dry run names the model it would use');
  assert.match(lines, /effort selected by/, 'and the effort it would dispatch');
  await press(result, KEY.esc);
  const back = (await waitForScreen(screens, 4)).component;
  assert.match(view(back, 80), /^Economist$/m, 'Esc returns to the main panel');
  await press(back, KEY.esc);
  await running;
  assert.match(f.notifications.at(-1), /no changes/i);
});

test('a cancelled in-flight simulation aborts and ignores its late result', async () => {
  const ctx = { ui: {} };
  const screens = attachScreens(ctx);
  let signal;
  let resolveRun;
  const { session, ...screen } = simulationScreen('en', {
    run: (_text, operationSignal) => new Promise((resolve) => {
      signal = operationSignal;
      resolveRun = resolve;
    }),
  });
  const owner = new AbortController();
  const opening = openPiSettings(ctx.ui, { session, ...screen, signal: owner.signal, locale: 'en' });
  const mounted = await waitForScreen(screens);
  const panel = mounted.component;
  await focus(panel, 'request');
  await press(panel, KEY.enter);
  await type(panel, 'pedido com ação');
  await press(panel, KEY.enter);
  await focus(panel, 'run');
  panel.handleInput(KEY.enter);
  for (let i = 0; i < 50 && !signal; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(signal && !signal.aborted, 'the simulation receives a live cancellation signal');
  for (const width of [40, 80, 120]) view(panel, width);

  panel.handleInput(KEY.esc);
  assert.equal(signal.aborted, true, 'Esc cancels the pending operation');
  resolveRun(['late result that must not appear']);
  await panel.drain();
  await new Promise((r) => setImmediate(r));
  assert.equal(mounted.closed, false, 'a late result never closes the screen');
  assert.equal(panel.controller.closedWith, undefined, 'and is never handed over');
  assert.doesNotMatch(view(panel, 120), /late result/);

  await press(panel, KEY.esc, KEY.esc);
  const result = await opening;
  assert.equal(result.action, undefined);
});

test('the panel renders without models or providers and keeps Unicode within 40/80/120 columns', async (t) => {
  const { f, screens } = await open(t, '', []);
  const running = f.command('economist', '');
  const panel = (await waitForScreen(screens)).component;
  for (const width of [40, 80, 120]) {
    const rendered = view(panel, width);
    assert.match(rendered, /Economist/);
    assert.match(rendered, /·/);
  }
  await press(panel, KEY.esc);
  await running;
});

test('pool rows with wide Unicode model names stay within the terminal width', async (t) => {
  const wide = [chat('模型/ü-ação-🚀', 0.5), chat('cheap/model', 0.2)];
  const { f, screens } = await open(
    t,
    'modelEconomist:\n  candidates:\n    - id: openrouter/模型/ü-ação-🚀\n      tier: 2\n      tools: true\n    - id: openrouter/cheap/model\n      tier: 1\n      tools: true\n',
    wide,
  );
  const running = f.command('economist', '');
  const main = (await waitForScreen(screens)).component;
  await focus(main, 'pool');
  await press(main, KEY.enter);
  const pool = (await waitForScreen(screens, 2)).component;
  for (const width of [40, 80, 120]) assert.match(view(pool, width), /模型/);
  await press(pool, KEY.esc);
  await press((await waitForScreen(screens, 3)).component, KEY.esc);
  await running;
});

test('a terminal below 40x12 asks to be enlarged instead of drawing a broken panel', async (t) => {
  const { f, screens } = await open(t, '', POOL, { rows: 10 });
  const running = f.command('economist', '');
  const panel = (await waitForScreen(screens)).component;
  assert.match(view(panel, 80), /Terminal too small/);
  assert.match(view(panel, 30), /Terminal too small/);
  await press(panel, KEY.esc);
  await running;
});

test('the last-decision row quotes the last real decision and opens it read-only', async (t) => {
  const { f, screens } = await open(
    t,
    'modelEconomist:\n  mode: rules\n  enabled: true\n  candidates:\n    - id: openrouter/cheap/model\n      tier: 1\n      tools: true\n',
  );
  await f.pi.virtual.route(
    { reason: 'user', messages: [{ role: 'user', content: 'olá' }], thinkingLevel: 'off' },
    f.ctx,
  );
  const running = f.command('economist', '');
  const main = (await waitForScreen(screens)).component;
  assert.match(view(main, 120), /Last decision\s+cheap\/model:off/);
  await focus(main, 'explain');
  await press(main, KEY.enter);
  const explain = (await waitForScreen(screens, 2)).component;
  const text = view(explain, 120);
  assert.match(text, /Last decision/);
  assert.match(text, /model \+ effort: openrouter\/cheap\/model:off/);
  assert.match(text, /read-only/);
  for (const width of [40, 80]) view(explain, width);
  await press(explain, KEY.esc);
  await press((await waitForScreen(screens, 3)).component, KEY.esc);
  await running;
});

test('a draft survives a trip to the read-only views', async (t) => {
  const { dir, f, screens } = await open(t);
  const running = f.command('economist', '');
  const main = (await waitForScreen(screens)).component;
  await choose(main, 'mode', 'rules');
  await choose(main, 'language', 'pt-BR');
  for (const id of ['economics', 'help']) {
    const index = screens.screens.length;
    await focus(screens.component, id);
    await press(screens.component, KEY.enter);
    const opened = (await waitForScreen(screens, index + 1)).component;
    assert.match(view(opened, 120), /somente leitura/, `${id} opens in the previewed language`);
    await press(opened, KEY.esc);
    const back = (await waitForScreen(screens, index + 2)).component;
    assert.match(view(back, 120), /Como avaliar a tarefa\s+rules/, 'the draft came back with the panel');
    assert.match(view(back, 80), /^Economist \*$/m);
  }
  assert.notEqual((await saved(dir)).modelEconomist.mode, 'rules');
  await press(screens.component, KEY.ctrlS);
  assert.equal((await saved(dir)).modelEconomist.mode, 'rules');
  assert.equal((await saved(dir)).modelEconomist.locale, 'pt-BR');
  await press(screens.component, KEY.esc);
  await running;
});

test('Esc during a save cancels it; a write that lands late is reconciled from storage', async (t) => {
  const { dir, f, screens } = await open(
    t,
    'modelEconomist:\n  enabled: false\n  candidates:\n    - id: openrouter/cheap/model\n      tier: 1\n      tools: true\n',
  );
  const setModel = f.pi.setModel;
  let release;
  f.pi.setModel = (model) => new Promise((resolve) => {
    release = () => resolve(setModel(model));
  });
  const running = f.command('economist', '');
  const panel = (await waitForScreen(screens)).component;
  await focus(panel, 'enabled');
  await press(panel, KEY.enter);
  assert.equal(panel.controller.session.draft.enabled, true);

  panel.handleInput(KEY.ctrlS);
  for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(panel.controller.session.saving, 'the save is in flight');
  assert.match(view(panel, 120), /Esc cancel save/);
  panel.handleInput(KEY.esc);
  await panel.drain();
  assert.match(view(panel, 120), /Save was not confirmed/);
  assert.equal((await saved(dir)).modelEconomist.enabled, false, 'nothing was written yet');

  release();
  for (let i = 0; i < 100 && (await saved(dir)).modelEconomist.enabled !== true; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal((await saved(dir)).modelEconomist.enabled, true, 'the late write reached the disk');
  await press(panel, KEY.ctrlS);
  assert.match(view(panel, 120), /Storage checked/);
  assert.equal(panel.controller.session.dirty, false, 'the stored state now matches the draft');
  await press(panel, KEY.esc);
  await running;
});

test('a session switch closes the panel, drops the draft and reports nothing into the next session', async (t) => {
  const { dir, f, screens } = await open(t);
  const running = f.command('economist', '');
  const screen = await waitForScreen(screens);
  await choose(screen.component, 'mode', 'rules');
  const notices = f.notifications.length;
  f.ctx.sessionManager.getSessionId = () => 'S2';
  await f.emit('session_switch');
  await running;
  assert.equal(screen.closed, true, 'the owner signal closed the panel');
  assert.notEqual((await saved(dir)).modelEconomist.mode, 'rules', 'the draft was not written');
  assert.equal(f.notifications.length, notices, 'no summary leaks into the new session');
});

test('a second /economist while the panel is open says so instead of stacking a panel', async (t) => {
  const { f, screens } = await open(t);
  const running = f.command('economist', '');
  const screen = await waitForScreen(screens);
  await f.command('economist', '');
  assert.equal(screens.screens.length, 1);
  assert.match(f.notifications.at(-1), /already open/);
  await press(screen.component, KEY.esc);
  await running;
});
