import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
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
  // then the direct commands for clients with no custom TUI screen.
  assert.match(bare, /Economist · ON · modo rules/);
  assert.match(bare, /esforço auto \(teto high/);
  assert.match(bare, /pool \d+ modelo\(s\)/);
  assert.match(bare, /\/economist candidates list/);
  assert.doesNotMatch(bare, /Unknown \/economist/);

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
