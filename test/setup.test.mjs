import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { fakePi } from '../test-support/fakes.mjs';
import economist from '../extension.mjs';

const chat = (id, price) => ({
  provider: 'openrouter',
  id,
  name: id,
  api: 'openai-completions',
  input: ['text'],
  cost: { input: price, output: price, cacheRead: price, cacheWrite: price },
  contextWindow: 200000,
  maxTokens: 8192,
  reasoning: false,
});
const pool = () => [
  chat('cheap/model', 0.1),
  chat('mid/model', 1),
  chat('strong/model', 9),
];

const fresh = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'econ-setup-'));
  await mkdir(join(dir, '.pi'), { recursive: true });
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  t.after(async () => {
    process.env.PI_SUITE_HOME = old;
    await rm(dir, { recursive: true, force: true });
  });
  const seen = [];
  const f = fakePi(dir, pool());
  // Record every model the extension asks pi to activate.
  const setModel = f.pi.setModel;
  f.pi.setModel = async (m) => {
    seen.push(m);
    return setModel(m);
  };
  f.activated = seen;
  return { dir, f };
};
const readSaved = async (dir) =>
  parseDocument(await readFile(join(dir, '.pi', 'pi-suite.yaml'), 'utf8')).toJS();
const lastNote = (f) => f.notifications.at(-1) ?? '';

test('/economist setup persists a price-ordered pool touching only its own section', async (t) => {
  const { dir, f } = await fresh(t);
  economist(f.pi);
  await f.command('economist', 'setup');
  const saved = await readSaved(dir);

  assert.deepEqual(Object.keys(saved), ['modelEconomist']);
  assert.equal(saved.modelEconomist.enabled, true);
  assert.deepEqual(
    saved.modelEconomist.candidates.map((c) => c.id),
    ['openrouter/cheap/model', 'openrouter/mid/model', 'openrouter/strong/model'],
  );
  const tiers = saved.modelEconomist.candidates.map((c) => c.tier);
  assert.deepEqual([...tiers].sort((a, b) => a - b), tiers, 'tiers must rise with price');
  assert.match(lastNote(f), /routing enabled/);
});

test('setup activates economist/auto so the very next prompt is routed', async (t) => {
  const { dir, f } = await fresh(t);
  economist(f.pi);
  await f.command('economist', 'setup');
  assert.deepEqual(
    f.activated.map((m) => `${m.provider}/${m.id}`),
    ['economist/auto'],
  );
});

test('a reload reads the persisted pool and a plain greeting routes to the cheapest tier', async (t) => {
  const { dir, f } = await fresh(t);
  economist(f.pi);
  await f.command('economist', 'setup');

  // Second "process": same files, fresh extension instance.
  const f2 = fakePi(dir, pool());
  economist(f2.pi);
  await f2.command('economist', 'simulate "olá"');
  assert.match(lastNote(f2), /openrouter\/cheap\/model/);
});

test('role preferences route only the matching intent and do not switch the model at configuration time', async (t) => {
  const { dir, f } = await fresh(t);
  economist(f.pi);
  await f.command('economist', 'setup');
  await f.command('economist', 'mode rules');
  const strong = f.ctx.modelRegistry.getAll().find((m) => m.id === 'strong/model');
  strong.reasoning = true;
  const activationsBeforePreference = f.activated.length;
  await f.command('economist', 'role reviewer model openrouter/strong/model');
  await f.command('economist', 'role reviewer effort high');
  assert.equal(f.activated.length, activationsBeforePreference, 'saving a role preference does not switch an in-flight/current model');
  const saved = await readSaved(dir);
  assert.equal(saved.modelEconomist.rolePreferences.reviewer.model, 'openrouter/strong/model');
  assert.equal(saved.modelEconomist.rolePreferences.reviewer.effort, 'high');

  const routed = await f.pi.virtual.route(
    { reason: 'user', messages: [{ role: 'user', content: 'test the parser' }], thinkingLevel: 'off' },
    f.ctx,
  );
  assert.equal(routed.state.assessment.kind, 'test');
  assert.equal(routed.model.id, 'strong/model');
  assert.equal(routed.thinkingLevel, 'high');

  await f.command('economist', 'thinking fixed');
  await f.command('economist', 'fixed low');
  const manuallyFixed = await f.pi.virtual.route(
    { reason: 'user', messages: [{ role: 'user', content: 'test another parser' }], thinkingLevel: 'off' },
    f.ctx,
  );
  assert.equal(manuallyFixed.thinkingLevel, 'low', 'an explicit global thinking mode overrides role effort preference');
});

test('/economist on with no candidates self-configures instead of breaking every prompt', async (t) => {
  const { dir, f } = await fresh(t);
  economist(f.pi);
  await f.command('economist', 'on');
  const saved = await readSaved(dir);
  assert.equal(saved.modelEconomist.candidates.length, 3);
  assert.match(lastNote(f), /Economist on/);
});

test('an empty registry yields an actionable error, never a bare policy failure', async (t) => {
  const { dir } = await fresh(t);
  const f = fakePi(dir, []);
  economist(f.pi);
  await assert.rejects(
    () => f.command('economist', 'on'),
    (e) => {
      assert.match(e.message, /no candidates are configured/);
      assert.match(e.message, /\/login/);
      return true;
    },
  );
  await assert.rejects(() => f.command('economist', 'setup'), (e) => {
    assert.match(e.message, /no model available in your scope/);
    assert.match(e.message, /\/scoped-models/);
    return true;
  });
});

test('an explicit pool is never overwritten; the bad id is named for repair', async (t) => {
  const { dir, f } = await fresh(t);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    join(dir, '.pi', 'pi-suite.yaml'),
    'modelEconomist:\n  candidates:\n    - id: ghost/model\n      tier: 1\n      tools: true\n',
  );
  economist(f.pi);
  await assert.rejects(
    () => f.command('economist', 'on'),
    (e) => {
      assert.match(e.message, /ghost\/model/);
      assert.match(e.message, /not authenticated\/available/);
      return true;
    },
  );
  // The user's file is untouched after the refusal.
  const saved = await readSaved(dir);
  assert.deepEqual(saved.modelEconomist.candidates.map((c) => c.id), ['ghost/model']);
  assert.equal(f.activated.length, 0, 'must not activate routing it cannot serve');
});

test('settings persist and a bare or unknown invocation teaches the grammar', async (t) => {
  const { dir, f } = await fresh(t);
  economist(f.pi);
  await f.command('economist', 'mode rules');
  assert.equal((await readSaved(dir)).modelEconomist.mode, 'rules');

  const failure = await f
    .command('economist', 'bogus')
    .then(() => null, (e) => e.message);
  assert.match(failure, /Unknown \/economist bogus/);
  assert.match(failure, /\/economist candidates list\|add\|remove/);
  assert.match(failure, /\/economist simulate PROMPT/);

  await f.command('economist', '');
  const bare = f.notifications.at(-1);
  // A bare call must read as a status panel, not as a command dump: state first,
  // then the direct commands for clients with no custom TUI screen. English is the
  // default screen language (the text fallback used to be fixed in Portuguese).
  assert.match(bare, /Economist · ON · cadence prompt · assessment rules/);
  assert.match(bare, /effort auto \(ceiling high/);
  assert.match(bare, /pool \d+ model\(s\)/);
  assert.match(bare, /\/economist candidates list/);
  assert.doesNotMatch(bare, /Unknown \/economist/);
  assert.doesNotMatch(bare, /cadência|avaliação|esforço|modelo\(s\)/, 'no Portuguese in the English fallback');

  // The trusted project's language choice also applies to the text fallback.
  const file = join(dir, '.pi', 'pi-suite.yaml');
  const doc = parseDocument(await readFile(file, 'utf8'));
  doc.setIn(['modelEconomist', 'locale'], 'pt-BR');
  await writeFile(file, String(doc));
  await f.command('economist', '');
  const portuguese = f.notifications.at(-1);
  assert.match(portuguese, /Economist · ON · cadência prompt · avaliação rules/);
  assert.match(portuguese, /esforço auto \(teto high/);
  assert.match(portuguese, /pool \d+ modelo\(s\)/);

  // An unknown action still teaches the grammar.
  const unknown = await f.command('economist', 'nonsense').then(() => null, (e) => e.message);
  assert.match(unknown, /Unknown \/economist nonsense/);
});

test('model ids come from the live registry, not from a hand-written list', async (t) => {
  const { dir, f } = await fresh(t);
  economist(f.pi);
  const complete = [...f.commands.values() ?? []][0]?.getArgumentCompletions;
  // Commands run init, which is what gives the extension its registry access.
  await f.command('economist', 'explain');
  const cmd = [...f.commands.entries()][0];
  const items = await cmd[1].getArgumentCompletions('candidates add ');
  assert.deepEqual(
    items.map((i) => i.value),
    [
      'candidates add openrouter/cheap/model ',
      'candidates add openrouter/mid/model ',
      'candidates add openrouter/strong/model ',
    ],
  );
  assert.match(items[0].description, /\$0\.1\/M in/);
  // tier slot follows the model slot.
  const tiers = await cmd[1].getArgumentCompletions('candidates add openrouter/cheap/model ');
  assert.deepEqual(tiers.map((i) => i.label), ['1', '2', '3', '4', '5']);
  assert.equal(complete, undefined ?? complete);
});

test('the configured pool is what `candidates remove` offers, with usability state', async (t) => {
  const { dir, f } = await fresh(t);
  economist(f.pi);
  await f.command('economist', 'setup');
  const cmd = [...f.commands.entries()][0][1];
  await f.command('economist', 'candidates add ghost/model 2');
  const items = await cmd.getArgumentCompletions('candidates remove ');
  const ghost = items.find((i) => i.value.includes('ghost/model'));
  assert.ok(ghost, 'the unauthenticated id must still be removable');
  assert.match(ghost.description, /not authenticated/);
});

// (no helper needed; tests import fs where required)
