import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import install from '../extension.mjs';
import {
  assess,
  rank,
  defaults,
  decideEffort,
  clampLevel,
  supportedLevels,
  effortTokens,
  levels,
} from '../routing.mjs';
import { dashboardItems, explainLines, candidateActions, tierForPool } from '../menu.mjs';
import { fakePi } from '../test-support/fakes.mjs';

const conf = defaults.modelEconomist;
const thinking = conf.thinking;

/** A model that can reason, plus one that cannot. */
const model = (id, { tier = 1, price = 1, reasoning = true, vision = false, map } = {}) => ({
  provider: 'p',
  id,
  api: 'x',
  auth: true,
  tier,
  tools: true,
  input: vision ? ['text', 'image'] : ['text'],
  contextWindow: 200000,
  cost: { input: price, output: price },
  reasoning,
  thinkingLevelMap: map,
});

test('effort comes from difficulty and risk raises it above the difficulty mapping', () => {
  assert.equal(decideEffort(assess('olá'), thinking).level, 'off', 'trivial never thinks');
  assert.equal(
    decideEffort(assess('explique como este módulo funciona'), thinking).level,
    'low',
    'simple reads cheap',
  );
  assert.equal(decideEffort(assess('adicione testes no parser'), thinking).level, 'medium');
  const risky = assess('altere a senha do banco');
  assert.ok(risky.risks.length, 'credentials and database are risks');
  assert.equal(decideEffort(risky, thinking).level, 'high');
  const lifted = decideEffort(risky, { ...thinking, riskFloor: 'max', ceiling: 'max' });
  assert.equal(lifted.level, 'max');
  assert.equal(lifted.source, 'risk', 'risk outranks the difficulty mapping');
  assert.equal(
    decideEffort(
      risky,
      { ...thinking, riskFloor: 'max', useSelectedAs: 'ceiling', riskOverridesSelection: false },
      'off',
    ).level,
    'off',
    'a hard ceiling (selected caps, risk does not lift) is honoured even against risk',
  );
});

test('a selected level caps un-risky work, but pi’s default off is not an opinion', () => {
  const moderate = assess('adicione testes no parser');
  assert.equal(decideEffort(moderate, thinking, 'minimal').level, 'minimal');
  assert.equal(decideEffort(moderate, thinking, 'off').level, 'medium', 'off = no opinion');
  assert.equal(decideEffort(moderate, { ...thinking, useSelectedAs: 'ceiling' }, 'off').level, 'off');
  assert.equal(decideEffort(moderate, { ...thinking, useSelectedAs: 'ignore' }, 'low').level, 'medium');
  assert.equal(
    decideEffort(assess('refatorar a saga de pagamentos'), { ...thinking, ceiling: 'low' }, 'max')
      .level,
    'low',
    'the ceiling is absolute',
  );
  assert.equal(decideEffort({}, { ...thinking, mode: 'follow' }, 'high').level, 'high');
  assert.equal(decideEffort({}, { ...thinking, mode: 'fixed', fixed: 'xhigh' }, 'low').level, 'xhigh');
});

test('a level is clamped down to what the physical model can actually run', () => {
  assert.deepEqual(supportedLevels(model('no-think', { reasoning: false })), ['off']);
  assert.equal(clampLevel('high', model('no-think', { reasoning: false })), 'off');
  const partial = model('capped', {
    map: { minimal: 'm', low: 'l', medium: null, high: 'h', xhigh: null, max: null },
  });
  assert.equal(clampLevel('high', partial), 'high');
  assert.equal(clampLevel('xhigh', partial), 'high', 'a null map entry is unsupported');
  assert.equal(clampLevel('medium', partial), 'low', 'downgrade, never upgrade');
  assert.ok(effortTokens(thinking, 'high', 2048) > effortTokens(thinking, 'off', 256));
});

test('rank prices effort per model and refuses reasoning where the task needs it', () => {
  const cheapNoThink = model('dumb', { tier: 2, price: 1, reasoning: false });
  const pricedThink = model('smart', { tier: 3, price: 4 });
  const complex = assess('refatorar o módulo de billing');
  const plain = rank([cheapNoThink, pricedThink], complex, conf);
  assert.equal(plain.accepted[0].model.id, 'dumb', 'cheapest wins without effort accounting');
  const effort = {
    requested: 'high',
    thinking,
    levels: {},
    requireReasoning: false,
  };
  const withEffort = rank([cheapNoThink, pricedThink], complex, conf, [], null, 0, effort);
  assert.equal(withEffort.accepted[0].model.id, 'dumb');
  assert.equal(withEffort.accepted[0].thinkingLevel, 'off', 'no thinking, no reasoning tokens');
  assert.equal(withEffort.accepted[1].thinkingLevel, 'high');
  const gated = rank([cheapNoThink, pricedThink], complex, conf, [], null, 0, {
    ...effort,
    requireReasoning: true,
  });
  assert.equal(gated.accepted.length, 1);
  assert.equal(gated.accepted[0].model.id, 'smart');
  assert.ok(gated.rejected.some((r) => r.reasonCodes.includes('reasoning-unavailable')));
  const ace = rank([pricedThink], complex, conf, [], null, 0, {
    ...effort,
    levels: { 'p/smart': 'low' },
  });
  assert.equal(ace.accepted[0].thinkingLevel, 'low', 'a scoped :level is an ace');
  assert.ok(
    ace.accepted[0].outputTokens < effortTokens(thinking, 'high', 2048),
    'the scoped level is the one priced',
  );
});

/** A session where `/scoped-models` narrowed the catalogue to two of four models. */
const scopedSetup = async (t, { scopedLevel, visionOutside = true } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'economist-scope-'));
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  t.after(async () => {
    if (old === undefined) delete process.env.PI_SUITE_HOME;
    else process.env.PI_SUITE_HOME = old;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, '.pi'), { recursive: true });
  const catalogue = [
    model('scoped/cheap', { tier: 1, price: 0.5 }),
    model('scoped/mid', { tier: 2, price: 2 }),
    model('other/vision', { tier: 1, price: 1, vision: visionOutside }),
    model('other/huge', { tier: 4, price: 8 }),
  ];
  const f = fakePi(dir, catalogue);
  const scoped = catalogue.filter((m) => m.id.startsWith('scoped/'));
  f.ctx.scopedModels = scoped.map((m) => ({ model: m, thinkingLevel: scopedLevel }));
  install(f.pi);
  await f.emit('session_start');
  return { dir, f, catalogue };
};

test('the pool comes from /scoped-models, not the whole catalogue', async (t) => {
  const { f } = await scopedSetup(t);
  await f.command('economist', 'on');
  const route = await f.pi.virtual.route(
    { reason: 'user', messages: [{ role: 'user', content: 'olá' }], thinkingLevel: 'off' },
    f.ctx,
  );
  assert.match(route.model.id, /^scoped\//, 'only scoped models are eligible');
  assert.equal(route.thinkingLevel, 'off', 'trivial work dispatches no reasoning');
  // An explicitly configured model that left the scope is refused, not silently used.
  await f.command('economist', 'candidates add p/other/huge 4');
  const rejected = (await f.command('economist', 'candidates list'), f.notifications.at(-1));
  assert.match(rejected, /outside \/scoped-models/);
});

test('scope all restores the whole catalogue and a scoped :level pins effort', async (t) => {
  const { f } = await scopedSetup(t, { scopedLevel: 'high' });
  await f.command('economist', 'on');
  const pinned = await f.pi.virtual.route(
    {
      reason: 'user',
      messages: [{ role: 'user', content: 'refatorar o módulo de billing' }],
      thinkingLevel: 'off',
    },
    f.ctx,
  );
  assert.equal(pinned.thinkingLevel, 'high', 'the scoped ace outranks the difficulty mapping');
  await f.command('economist', 'scope all');
  const wide = await f.pi.virtual.route(
    { reason: 'user', messages: [{ role: 'user', content: 'olá' }], thinkingLevel: 'off' },
    f.ctx,
  );
  assert.ok(['scoped/cheap', 'other/vision'].includes(wide.model.id), 'catalogue is back');
  await f.command('economist', 'thinking follow');
  const followed = await f.pi.virtual.route(
    {
      reason: 'user',
      messages: [{ role: 'user', content: 'refatorar o módulo de billing' }],
      thinkingLevel: 'minimal',
    },
    f.ctx,
  );
  assert.equal(followed.thinkingLevel, 'minimal', 'follow hands /thinking straight through');
});

test('a vision task outside the scope asks, helps choose, and can be saved', async (t) => {
  const { f, dir } = await scopedSetup(t);
  await f.command('economist', 'on');
  const asked = [];
  f.ctx.ui.confirm = async (title, message) => {
    asked.push(`confirm:${title}`);
    return true;
  };
  f.ctx.ui.select = async (title, options) => {
    asked.push(`select:${title}`);
    assert.match(title, /vision/, 'the choice is framed as a vision pick');
    assert.ok(options.length >= 1);
    return options[0];
  };
  const route = await f.pi.virtual.route(
    {
      reason: 'user',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'explique esta imagem' }, { type: 'image', data: 'x' }],
        },
      ],
      thinkingLevel: 'off',
    },
    f.ctx,
  );
  assert.equal(route.model.id, 'other/vision', 'rescued by the unscoped vision model');
  assert.deepEqual(
    asked.map((a) => a.split(':')[0]),
    ['confirm', 'select', 'confirm'],
    'asked to borrow, helped to choose, then asked whether to keep it',
  );
  assert.match(asked[1], /vision/, 'the choice is framed as a vision pick');
  const saved = await readFileText(join(dir, '.pi', 'pi-suite.yaml'));
  assert.match(saved, /other\/vision/, 'the pool keeps the model it was told to save');
  // Second vision turn reuses the saved pool without asking again.
  asked.length = 0;
  const second = await f.pi.virtual.route(
    {
      reason: 'continuation',
      previous: route,
      state: route.state,
      messages: [{ role: 'user', content: 'e?' }],
    },
    f.ctx,
  );
  assert.equal(second.model.id, 'other/vision');
  assert.equal(asked.length, 0, 'no nagging once it is in the pool');
});

test('declining the vision rescue stays actionable instead of failing blind', async (t) => {
  const { f } = await scopedSetup(t);
  await f.command('economist', 'on');
  f.ctx.ui.confirm = async () => false;
  const imageRequest = {
    reason: 'user',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'explique esta imagem' }, { type: 'image', data: 'x' }],
      },
    ],
    thinkingLevel: 'off',
  };
  await assert.rejects(() => f.pi.virtual.route(imageRequest, f.ctx), /scoped-models/);
  await assert.rejects(
    () => f.pi.virtual.route(imageRequest, f.ctx),
    /declined/,
    'a refused rescue is not asked again, and still explains itself',
  );
});

test('simulate prices the effort it will actually dispatch, free of charge', async (t) => {
  const { f } = await scopedSetup(t);
  await f.command('economist', 'on');
  await f.command('economist', 'simulate "refatorar o módulo de billing"');
  const shown = f.notifications.at(-1);
  assert.match(shown, /selectedThinkingLevel: medium/, 'effort is part of what a simulation reports');
  assert.match(shown, /effortSource: difficulty/);
  assert.doesNotMatch(shown, /classifierCostUsd: [1-9]/, 'simulate never pays a classifier');
});

test('the dashboard reflects live config and the pool helpers stay pure', () => {
  const live = {
    ...conf,
    enabled: false,
    mode: 'rules',
    thinking: { ...conf.thinking, mode: 'follow', ceiling: 'xhigh', riskFloor: 'medium' },
    scope: { source: 'all', strict: false },
  };
  const items = dashboardItems({
    conf: live,
    pool: [{ id: 'a' }, { id: 'b' }],
    scoped: 2,
    last: null,
    notes: { modes: ['rules', 'hybrid'], policies: ['balanced'], levels },
  });
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId.enabled.currentValue, 'off');
  assert.equal(byId.thinking.currentValue, 'follow');
  assert.equal(byId.ceiling.currentValue, 'xhigh');
  assert.equal(byId['risk-floor'], undefined);
  assert.equal(byId['selected-as'], undefined);
  assert.equal(byId.cadence.currentValue, 'prompt');
  assert.equal(byId.scope.currentValue, 'all');
  assert.equal(byId['scope-strict'], undefined);
  assert.equal(byId.classifier, undefined);
  assert.equal(byId.poolAdd, undefined);
  assert.equal(byId.poolEdit, undefined);
  assert.equal(byId.pool.currentValue, '2 modelo(s)');
  assert.ok(items.every((i) => i.description), 'every row explains itself');
  assert.equal(tierForPool(0, 1), 1);
  assert.ok(tierForPool(3, 4) > tierForPool(0, 4), 'a pricier index gets a higher tier');
  const actions = candidateActions({ tier: 2, tools: true });
  assert.deepEqual(
    actions.filter((a) => a.value.startsWith('tier:')).map((a) => a.description.includes('atual')),
    [false, true, false, false, false],
    'the current tier is marked',
  );
  assert.ok(actions.some((a) => a.value === 'remove'));
  assert.match(explainLines(null, conf).join(' '), /Simular/);
  assert.match(
    explainLines(
      {
        selectedModelId: 'p/smart',
        selectedThinkingLevel: 'high',
        effortSource: 'risk',
        reasonCodes: ['balanced', 'effort:high'],
        assessment: { kind: 'edit', difficulty: 'complex', risks: ['security'] },
        candidates: [{ model: 'p/smart', thinkingLevel: 'high' }],
        rejected: [{ model: 'p/dumb', reasonCodes: ['tier'] }],
      },
      conf,
    ).join('\n'),
    /p\/smart:high[\s\S]*esforço definido por: risk[\s\S]*dumb \(tier\)/,
  );
});

const readFileText = async (path) => (await import('node:fs/promises')).readFile(path, 'utf8');
