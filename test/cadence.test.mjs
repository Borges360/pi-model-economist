import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import install from '../extension.mjs';
import { fakePi } from '../test-support/fakes.mjs';
import { fakeTui } from '../test-support/fake-tui.mjs';

const models = [
  { provider: 'fake', id: 'cheap', api: 'test', input: ['text'], reasoning: true, contextWindow: 200000, cost: { input: 0.1, output: 0.1 } },
  { provider: 'fake', id: 'strong', api: 'test', input: ['text'], reasoning: true, contextWindow: 200000, cost: { input: 3, output: 3 } },
];
const config = `modelEconomist:
  enabled: true
  mode: rules
  candidates:
    - id: fake/cheap
      tier: 1
      tools: true
    - id: fake/strong
      tier: 5
      tools: true
`;
async function fixture(t, extra = '') {
  const dir = await mkdtemp(join(tmpdir(), 'economist-cadence-'));
  const previous = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  t.after(async () => {
    if (previous == null) delete process.env.PI_SUITE_HOME;
    else process.env.PI_SUITE_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, '.pi'));
  await writeFile(join(dir, '.pi', 'pi-suite.yaml'), config + extra);
  const f = fakePi(dir, models);
  install(f.pi);
  await f.emit('session_start');
  return { f, dir };
}
const prompt = (text, state) => ({ reason: 'user', messages: [{ role: 'user', content: text }], thinkingLevel: 'medium', state });

test('enabled config selects auto on a fresh session but respects an existing manual session', async (t) => {
  const { f } = await fixture(t);
  assert.equal(f.ctx.model.id, 'auto');
  assert.equal(f.ctx.model.provider, 'economist');
  assert.equal(f.ctx.footerFactory, undefined, 'without host UI integration keep default footer');
  await f.pi.setModel(models[1]);
  assert.equal(f.ctx.model.id, 'strong', 'do not steal later manual /model selections');
  f.entries.push({ type: 'message', message: { role: 'user', content: 'existing' } });
  await f.emit('session_start');
  assert.equal(f.ctx.model.id, 'strong', 'do not steal resumed conversations');
});

test('session pins first route while prompt re-evaluates; auto effort ignores virtual medium', async (t) => {
  const { f } = await fixture(t);
  await f.command('economist', 'cadence session');
  const first = await f.pi.virtual.route(prompt('oi'), f.ctx);
  assert.equal(first.model.id, 'cheap');
  assert.equal(first.thinkingLevel, 'off');
  const pinned = await f.pi.virtual.route(prompt('corrija problema de segurança', first.state), f.ctx);
  assert.equal(pinned.model.id, 'cheap');
  await f.command('economist', 'cadence prompt');
  const rechecked = await f.pi.virtual.route(prompt('corrija problema de segurança', pinned.state), f.ctx);
  assert.equal(rechecked.model.id, 'strong');
});

test('session releases the pin after a manual /model and chooses again on economist/auto', async (t) => {
  const { f } = await fixture(t);
  await f.command('economist', 'cadence session');
  const first = await f.pi.virtual.route(prompt('oi'), f.ctx);
  assert.equal(first.model.id, 'cheap');
  f.entries.push(
    {
      type: 'custom',
      customType: 'pi.virtual-model-state',
      data: { provider: 'economist', modelId: 'auto', state: first.state },
    },
    { type: 'model_change', provider: 'fake', modelId: 'strong' },
    { type: 'model_change', provider: 'economist', modelId: 'auto' },
  );
  const again = await f.pi.virtual.route(prompt('corrija problema de segurança', first.state), f.ctx);
  assert.equal(again.model.id, 'strong');
  const held = await f.pi.virtual.route(prompt('oi', again.state), f.ctx);
  assert.equal(held.model.id, 'strong', 'the new choice stays until the next manual /model');
});

test('prompt re-evaluates a short follow-up using the recent conversation', async (t) => {
  const { f } = await fixture(t);
  await f.command('economist', 'cadence prompt');
  const followUp = {
    reason: 'user',
    thinkingLevel: 'medium',
    messages: [
      { role: 'user', content: 'corrija problema de segurança' },
      { role: 'assistant', content: 'vou olhar' },
      { role: 'user', content: 'continua' },
    ],
  };
  const routed = await f.pi.virtual.route(followUp, f.ctx);
  assert.equal(routed.model.id, 'strong');
});

test('subagent support recommends independently without changing the parent model', async (t) => {
  const { f } = await fixture(t);
  await f.command('economist', 'cadence subagent');
  const result = await f.pi.tool.execute('call-1', { task: 'corrija problema de segurança' }, null, null, f.ctx);
  assert.equal(result.details.model, 'fake/strong');
  assert.equal(result.structuredContent.thinkingLevel, result.details.thinkingLevel);
  assert.ok(Array.isArray(result.content));
  assert.equal(f.ctx.model.id, 'auto');
  const saved = await readFile(join(f.ctx.cwd, '.pi', 'pi-suite.yaml'), 'utf8');
  assert.match(saved, /cadence: subagent/);
});

test('Ctrl+S persists the currently configured section in the real menu callback', async (t) => {
  const { f, dir } = await fixture(t);
  const tui = fakeTui();
  f.ctx.ui.custom = (factory) => new Promise((resolve) => {
    f.screen = factory({ requestRender() {} }, tui.theme, tui.keybindings, resolve);
  });
  // runDashboard is host-wired by the extension factory, not by an external TUI.
  // Supply the fake only for this test; the production entry uses static imports.
  const { host } = await import('../menu.mjs');
  host.tui = tui.tuiPkg;
  host.agent = tui.agentPkg;
  t.after(() => { host.tui = undefined; host.agent = undefined; });
  const running = f.command('economist', '');
  await new Promise((r) => setImmediate(r));
  await f.screen.handleInput('\u0013');
  assert.match(await readFile(join(dir, '.pi', 'pi-suite.yaml'), 'utf8'), /enabled: true/);
  assert.match(f.notifications.join('\n'), /Configuração salva/);
  tui.created.settings[0].onCancel();
  await running;
});

test('the footer shows one AUTO pair, never the repeated virtual medium', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'economist-footer-'));
  const previous = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  t.after(async () => {
    if (previous == null) delete process.env.PI_SUITE_HOME;
    else process.env.PI_SUITE_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, '.pi'));
  await writeFile(join(dir, '.pi', 'pi-suite.yaml'), config);
  const f = fakePi(dir, models);
  const tuiStub = { visibleWidth: (s) => s.length, truncateToWidth: (s, width) => s.slice(0, width) };
  install(f.pi, { tui: tuiStub });
  await f.emit('session_start');
  let renders = 0;
  let disposed = false;
  const footer = f.ctx.footerFactory(
    { requestRender() { renders++; } },
    { fg: (_c, s) => s },
    {
      getGitBranch: () => 'feature/footer',
      getExtensionStatuses: () => new Map([['economist', 'should-not-leak']]),
      onBranchChange: () => () => { disposed = true; },
    },
  );
  const routed = await f.pi.virtual.route(prompt('corrija problema de segurança'), f.ctx);
  assert.equal(renders, 1, 'a routing decision redraws the active footer');
  await f.pi.virtual.route({ ...prompt('continue', routed.state), reason: 'continuation', previous: routed }, f.ctx);
  assert.equal(renders, 2, 'a sticky continuation also redraws the footer');
  const line = footer.render(120)[0];
  assert.match(line, /AUTO fake\/strong · esforço high/);
  assert.doesNotMatch(line, /medium/, 'the virtual medium must not leak into the footer');
  assert.doesNotMatch(line, /should-not-leak/, 'economist status is not re-shown beside AUTO');
  assert.equal(line.split('AUTO').length - 1, 1, 'one AUTO label only');
  const narrow = footer.render(40);
  assert.match(narrow[0], /AUTO fake\/strong · esforço high/);
  assert.ok(narrow.every((row) => row.length <= 40));
  assert.match(narrow[1], /feature\/footer/);
  await f.pi.setModel(models[0]);
  assert.doesNotMatch(footer.render(120).join('\n'), /AUTO/);
  footer.dispose();
  assert.equal(disposed, true, 'unsubscribe from branch changes on disposal');
  await f.pi.virtual.route(prompt('oi'), f.ctx);
  assert.equal(renders, 2, 'a disposed footer must not receive redraw requests');
});
