import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDocument } from 'yaml';
import * as piTui from '@earendil-works/pi-tui';
import install from '../extension.mjs';
import { host, missingHostExports, HOST_EXPORTS } from '../menu.mjs';
import { fakePi } from '../test-support/fakes.mjs';
import { attachScreens, waitForScreen, press, choose, focus, view, KEY } from '../test-support/panel.mjs';

const POOL = [
  { provider: 'openrouter', id: 'cheap/model', name: 'cheap', api: 'openai-completions', input: ['text'], cost: { input: 0.2, output: 0.6 }, contextWindow: 200000, reasoning: true },
  { provider: 'openrouter', id: 'mid/model', name: 'mid', api: 'openai-completions', input: ['text'], cost: { input: 1, output: 4 }, contextWindow: 200000, reasoning: true },
];
const SEED =
  'modelEconomist:\n  mode: rules\n  policy: economy\n  enabled: true\n  candidates:\n    - id: openrouter/cheap/model\n      tier: 1\n      tools: true\n    - id: openrouter/mid/model\n      tier: 3\n      tools: true\n';

const open = async (t, extra = SEED, { globalExtra = '' } = {}) => {
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
  if (globalExtra) {
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(join(dir, 'state', 'config.yaml'), globalExtra);
  }
  const f = fakePi(dir, POOL);
  const screens = attachScreens(f.ctx);
  install(f.pi, { tui: { ...piTui } });
  await f.emit('session_start');
  return { dir, f, screens };
};

const saved = async (dir) =>
  parseDocument(await readFile(join(dir, '.pi', 'pi-suite.yaml'), 'utf8')).toJS().modelEconomist;

/**
 * What the panel row is supposed to leave in the file. Written from the config shape,
 * not from the field table, so the test fails when the table and the row disagree —
 * which is exactly how `selected-as` once shipped three values in the menu and
 * accepted two in the command path.
 */
const readBack = (id, c) =>
  ({
    language: c.locale ?? 'en',
    enabled: c.enabled === true,
    preset: c.preset,
    control: c.control,
    contextEnabled: c.context?.enabled !== false,
    retrievalBudget: String(c.context?.retrieval?.budgetTokens),
    privacyExecutor: c.executor?.dataPolicy,
    privacyClassifier: c.classifier?.dataPolicy,
    privacyTelemetry: c.telemetry?.dataPolicy,
    cadence: c.cadence,
    mode: c.mode,
    policy: c.policy,
    thinking: c.thinking?.mode,
    ceiling: c.thinking?.ceiling,
    fixed: c.thinking?.fixed,
    scope: c.scope?.source,
    rollout: c.rollout?.stage,
    algorithm: c.adaptive?.algorithm,
    bandit: c.adaptive?.bandit,
    delegation: c.topology?.enabled !== false,
  })[id];

test('every value the panel offers is accepted by the same table that writes it', async (t) => {
  const { dir, f, screens } = await open(t);
  const running = f.command('economist', '');
  const screen = await waitForScreen(screens);
  const panel = screen.component;
  const fields = panel.controller.session.fields;
  assert.ok(fields.length >= 20, `expected at least 20 fields, found ${fields.length}`);
  for (const field of fields) {
    if (field.kind === 'boolean') {
      const before = panel.controller.session.draft[field.id];
      await focus(panel, field.id);
      await press(panel, KEY.enter, KEY.ctrlS);
      assert.equal(readBack(field.id, await saved(dir)), !before, `${field.id}: Enter toggles and Ctrl+S writes it`);
      continue;
    }
    const values = field.choices.map((c) => c.id);
    // Language last on English, so the rest of the walk reads the English messages.
    const order = field.id === 'language' ? [...values].reverse() : values;
    for (const value of order) {
      await choose(panel, field.id, value);
      // Each choice is offered, so each must be written exactly as shown.
      await press(panel, KEY.ctrlS);
      if (field.id === 'bandit' && value === 'active') {
        // Active learning needs paired evidence: the panel keeps the draft and says why.
        assert.match(view(panel, 120), /Save failed; the draft was kept: Adaptive activation requires paired measured evidence/);
        assert.equal(panel.controller.session.dirty, true);
        await choose(panel, 'bandit', 'shadow');
        await press(panel, KEY.ctrlS);
        continue;
      }
      assert.equal(
        readBack(field.id, await saved(dir)),
        value,
        `${field.id}: the panel offered ${JSON.stringify(values)} and ${value} did not reach the file after Ctrl+S`,
      );
      assert.equal(screen.closed, false, `${field.id}: saving keeps the panel open`);
    }
  }
  assert.deepEqual(fields.find((f) => f.id === 'cadence').choices.map((c) => c.id), ['session', 'prompt', 'subagent']);
  assert.equal(fields.find((f) => f.id === 'selected-as'), undefined);
  await press(panel, KEY.esc);
  await running;
});

test('a global lock shows on the panel row and cannot be edited there either', async (t) => {
  const { f, screens } = await open(t, SEED, {
    globalExtra: 'locked:\n  modelEconomist:\n    thinking:\n      ceiling: high\n',
  });
  await assert.rejects(() => f.command('economist', 'ceiling low'), /locked by global policy/);
  const running = f.command('economist', '');
  const panel = (await waitForScreen(screens)).component;
  assert.match(view(panel, 120), /Effort ceiling\s+\S+\s+\[locked: global policy\]/);
  await focus(panel, 'ceiling');
  await press(panel, KEY.enter);
  assert.match(view(panel, 120), /Locked by global policy/);
  assert.equal(panel.controller.session.editing, undefined);
  await press(panel, KEY.esc);
  await running;
});

test('a missing host export degrades to the text panel and says which one, instead of throwing', async (t) => {
  const { f, screens } = await open(t);
  delete host.tui.Input;
  assert.deepEqual(missingHostExports(host.tui), ['@earendil-works/pi-tui.Input']);
  await f.command('economist', '');
  assert.equal(screens.screens.length, 0, 'no custom screen was mounted');
  assert.match(
    f.notifications.join('\n'),
    /settings panel unavailable.*Input/,
    'the degradation names the missing export',
  );
  // State first, commands after — never a bare grammar dump as the answer.
  const fallback = f.notifications.at(-1);
  assert.match(fallback, /Economist ·/);
  assert.ok(
    fallback.indexOf('pool') < fallback.indexOf('/economist on'),
    'the fallback panel shows state before the command lines',
  );
});

test('the host surface the panel needs is pinned, matches the vendored adapter and exists in pi-tui', async () => {
  assert.deepEqual(HOST_EXPORTS['@earendil-works/pi-tui'], [
    'Input',
    'matchesKey',
    'truncateToWidth',
    'visibleWidth',
    'Text',
  ]);
  assert.equal(HOST_EXPORTS['@earendil-works/pi-coding-agent'], undefined, 'the panel needs nothing from pi-coding-agent');
  assert.equal(missingHostExports(undefined).length, 5);
  assert.deepEqual(missingHostExports(piTui), [], 'the pinned pi-tui provides every export');
  // Provenance guard: the names the vendored adapter imports are the names pinned here.
  const adapter = await readFile(new URL('../vendor/inteiro-terminal/pi.js', import.meta.url), 'utf8');
  const imported = adapter.match(/import \{([^}]*)\} from "@earendil-works\/pi-tui"/)[1]
    .split(',').map((s) => s.trim()).filter(Boolean).sort();
  assert.deepEqual(imported, HOST_EXPORTS['@earendil-works/pi-tui'].filter((n) => n !== 'Text').sort());
});

test('a text-command write says it took effect instead of telling the user to /reload', async (t) => {
  const { dir, f } = await open(t);
  await f.command('economist', 'policy quality');
  assert.match(f.notifications.at(-1), /já em efeito/);
  assert.doesNotMatch(
    f.notifications.join('\n'),
    /run \/reload/i,
    'rt.save already applied the patch in memory; asking for a reload teaches the user to doubt the command',
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
  assert.match(entry, /install\(pi,\s*\{ tui: piTui, agent: piAgent, Agent, Type \}\)/);
  const extension = await readFile(new URL('../extension.mjs', import.meta.url), 'utf8');
  assert.match(extension, /provideHost\(injected\.tui, injected\.agent\)/);
  // The vendored adapter imports pi-tui statically too, and the panel module imports the
  // adapter statically: no dynamic import of a host module anywhere on the panel path.
  const menu = await readFile(new URL('../menu.mjs', import.meta.url), 'utf8');
  assert.match(menu, /^import \{ openPiSettings, piBindings \} from '\.\/vendor\/inteiro-terminal\/pi\.js';$/m);
  // The read-only view imports pi-tui statically as well, and only names pinned above.
  const own = menu.match(/^import \{([^}]*)\} from '@earendil-works\/pi-tui';$/m)?.[1]
    .split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  assert.ok(own.length, 'menu.mjs imports pi-tui statically');
  for (const name of own) assert.ok(HOST_EXPORTS['@earendil-works/pi-tui'].includes(name), `${name} is pinned in HOST_EXPORTS`);
  assert.doesNotMatch(menu, /^(?!\s*(\*|\/\/)).*\bimport\(\s*['"]@earendil-works/m, 'no dynamic host import outside comments');
});
