import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDocument } from 'yaml';
import install from '../extension.mjs';
import { host, missingHostExports, HOST_EXPORTS } from '../menu.mjs';
import { fakeTui } from '../test-support/fake-tui.mjs';
import { fakePi } from '../test-support/fakes.mjs';

const tick = () => new Promise((r) => setImmediate(r));
const POOL = [
  { provider: 'openrouter', id: 'cheap/model', name: 'cheap', api: 'openai-completions', input: ['text'], cost: { input: 0.2, output: 0.6 }, contextWindow: 200000, reasoning: true },
  { provider: 'openrouter', id: 'mid/model', name: 'mid', api: 'openai-completions', input: ['text'], cost: { input: 1, output: 4 }, contextWindow: 200000, reasoning: true },
];
const SEED =
  'modelEconomist:\n  mode: rules\n  policy: economy\n  enabled: true\n  candidates:\n    - id: openrouter/cheap/model\n      tier: 1\n      tools: true\n    - id: openrouter/mid/model\n      tier: 3\n      tools: true\n';

const open = async (t, extra = SEED) => {
  const dir = await mkdtemp(join(tmpdir(), 'econ-parity-'));
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  const savedHost = { tui: host.tui, agent: host.agent };
  t.after(async () => {
    process.env.PI_SUITE_HOME = old;
    host.tui = savedHost.tui;
    host.agent = savedHost.agent;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, '.pi'), { recursive: true });
  if (extra) await writeFile(join(dir, '.pi', 'pi-suite.yaml'), extra);
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
  parseDocument(await readFile(join(dir, '.pi', 'pi-suite.yaml'), 'utf8')).toJS().modelEconomist;

/**
 * What `FIELDS.patch` is supposed to leave in the file for a row. Written from the
 * config shape, not from the table, so the test fails when the table and the row
 * disagree — which is exactly how `selected-as` shipped three values in the dashboard
 * and accepted two in the command path.
 */
const readBack = (id, c) =>
  ({
    enabled: c.enabled ? 'on' : 'off',
    mode: c.mode,
    policy: c.policy,
    classifier: c.classifier?.enabled ? 'on' : 'off',
    thinking: c.thinking?.mode,
    ceiling: c.thinking?.ceiling,
    'risk-floor': c.thinking?.riskFloor,
    fixed: c.thinking?.fixed,
    'selected-as': c.thinking?.useSelectedAs,
    scope: c.scope?.source,
    'scope-strict': c.scope?.strict === false ? 'off' : 'on',
  })[id];

test('every value the dashboard offers is accepted by the same table that writes it', async (t) => {
  const { dir, f, tui } = await open(t);
  const running = f.command('economist', '');
  await tick();
  const settings = tui.created.settings[0];
  const rows = settings.items.filter((i) => Array.isArray(i.values) && i.values.length);
  assert.ok(rows.length >= 9, `esperava pelo menos 9 linhas enum, achei ${rows.length}`);
  for (const row of rows) {
    for (const value of row.values) await settings.cycle(row.id, value);
    const written = await saved(dir);
    assert.equal(
      readBack(row.id, written),
      row.values.at(-1),
      `${row.id}: o painel ofereceu ${JSON.stringify(row.values)} e o último valor não chegou ao arquivo`,
    );
  }
  // The regression itself: the declared default has to be selectable from the panel.
  const selectedAs = rows.find((r) => r.id === 'selected-as');
  assert.ok(
    selectedAs.values.includes('ceiling-if-set'),
    'ceiling-if-set é o default declarado e precisa estar na tabela',
  );
  await writeFile(join(dir, '.pi', 'pi-suite.yaml'), SEED);
  settings.onCancel();
  await running;
});

test('a missing host export degrades to the text panel and says which one, instead of throwing', async (t) => {
  const { f, tui } = await open(t);
  // The real host does not export DynamicBorder from pi-tui; deleting it from the
  // agent module reproduces a host that exposes even less than we expect.
  delete host.agent.DynamicBorder;
  assert.deepEqual(missingHostExports(tui.tuiPkg, host.agent), [
    '@earendil-works/pi-coding-agent.DynamicBorder',
  ]);
  await f.command('economist', '');
  assert.ok(!f.screen, 'nenhuma tela customizada foi montada');
  assert.match(
    f.notifications.join('\n'),
    /sem painel interativo.*DynamicBorder/,
    'a degradação precisa nomear o export ausente',
  );
  // State first, commands after — never a bare grammar dump as the answer.
  const fallback = f.notifications.at(-1);
  assert.match(fallback, /Economist ·/);
  assert.ok(
    fallback.indexOf('pool') < fallback.indexOf('/economist on'),
    'o painel de fallback mostra estado antes das linhas de comando',
  );
});

test('the host surface the screen needs is pinned per package (provenance guard)', () => {
  assert.deepEqual(HOST_EXPORTS['@earendil-works/pi-tui'], [
    'Container',
    'SettingsList',
    'SelectList',
    'Text',
    'Input',
  ]);
  assert.ok(
    HOST_EXPORTS['@earendil-works/pi-coding-agent'].includes('DynamicBorder'),
    'DynamicBorder é export do pi-coding-agent, não do pi-tui',
  );
  assert.deepEqual(missingHostExports(undefined, undefined).length, 8);
});

test('a text-command write says it took effect instead of telling the user to /reload', async (t) => {
  const { dir, f } = await open(t);
  await f.command('economist', 'policy quality');
  assert.match(f.notifications.at(-1), /já em efeito/);
  assert.doesNotMatch(
    f.notifications.join('\n'),
    /run \/reload/i,
    'rt.save já aplicou o patch em memória; mandar recarregar ensina o usuário a duvidar do comando',
  );
  assert.equal((await saved(dir)).policy, 'quality');
});

test('the pi entry point imports the host modules statically and hands them to the extension', async () => {
  // A dynamic `await import('@earendil-works/pi-tui')` from inside an extension is
  // resolved by Node, not by pi's jiti map, and fails with ERR_MODULE_NOT_FOUND
  // (proved by scripts/smoke-dashboard.mjs). So the entry point must supply the
  // modules; if anyone moves that back to a lazy-only import, this test says why not.
  const entry = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
  assert.match(entry, /import \* as piTui from ['"]@earendil-works\/pi-tui['"]/);
  assert.match(entry, /import \* as piAgent from ['"]@earendil-works\/pi-coding-agent['"]/);
  assert.match(entry, /install\(pi,\s*\{ tui: piTui, agent: piAgent \}\)/);
  const extension = await readFile(new URL('../extension.mjs', import.meta.url), 'utf8');
  assert.match(extension, /provideHost\(injected\.tui, injected\.agent\)/);
});
