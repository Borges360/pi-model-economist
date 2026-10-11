import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  assess,
  rank,
  defaults,
  Classifiers,
  validateAssessment,
  failureClass,
} from '../routing.mjs';
const c = defaults.modelEconomist;
const model = (id, tier, price) => ({
  provider: 'p',
  id,
  api: 'x',
  auth: true,
  tier,
  tools: true,
  input: ['text'],
  contextWindow: 64000,
  cost: { input: price, output: price },
});
test('risk tiers, tool compatibility, unknown prices, expected recovery and cache penalties', () => {
  const a = assess('Fix production database concurrency');
  const r = rank([model('small', 1, 1), model('strong', 3, 8)], a, c);
  assert.equal(r.accepted[0].model.id, 'strong');
  assert.ok(r.rejected[0].reasonCodes.includes('tier'));
  const normal = rank(
    [model('unknown', 1, 0), model('known', 1, 1)],
    assess('hello'),
    c,
    [],
    'p/other',
  );
  assert.equal(normal.accepted[0].model.id, 'known');
  assert.equal(normal.accepted.at(-1).expectedTotalCost, null);
  assert.ok(normal.accepted[0].cacheSwitchPenalty > 0);
  assert.equal(rank([{ ...model('bad', 3, 1), tools: false }], a, c).accepted.length, 0);
});
test('disabled classifier is free; unknown Jev price and timeout fall back finitely', async () => {
  const rules = assess('Review business logic');
  let called = 0;
  const classifier = new Classifiers();
  const ctx = {
    modelRegistry: {
      getAvailable: () => [],
      findOfType: () => ({ provider: 'typesafe', id: 'jev-latest' }),
      classify: () => {
        called++;
        return new Promise(() => {});
      },
    },
  };
  assert.equal(
    (await classifier.run('text', rules, ctx, { ...c.classifier, enabled: false })).cost,
    0,
  );
  assert.equal(called, 0);
  await classifier.run('text', rules, ctx, { ...c.classifier, engine: 'jev' });
  assert.equal(called, 0);
  const events = [];
  const r = await classifier.run(
    'api_key=never-leak',
    rules,
    ctx,
    {
      ...c.classifier,
      engine: 'jev',
      timeoutMs: 10,
      decisionPrices: { 'typesafe/jev-latest': 0.001 },
    },
    { emit: async (k, p) => events.push({ k, p }) },
  );
  assert.match(r.fallback, /timeout/);
  assert.equal(called, 1);
  assert.equal(events.length, 1);
});
test('strict small-LLM JSON validation and deterministic safety floor', async () => {
  const rules = assess('explain behaviour');
  const small = model('classify', 1, 0.1);
  const ctx = {
    modelRegistry: {
      findOfType: () => null,
      getAvailable: () => [small],
      streamSimple: (_m, context) => {
        assert.ok(!context.messages[0].content.includes('private-value'));
        return {
          result: async () => ({
            stopReason: 'stop',
            content: [
              {
                type: 'text',
                text: '{"kind":"edit","difficulty":"simple","risks":[],"requiresTools":true,"requiresLongContext":false,"requiresImageInput":false,"confidence":0.9,"signalSummary":[],"extra":1}',
              },
            ],
          }),
        };
      },
    },
  };
  const r = await new Classifiers().run('password=private-value', rules, ctx, {
    ...c.classifier,
    engine: 'small-llm',
    smallLlmCandidates: ['p/classify'],
  });
  assert.match(r.fallback, /Invalid/);
  assert.equal(r.assessment.classifier, 'rules');
  assert.equal(failureClass('context_length_exceeded'), 'context');
  assert.equal(failureClass('HTTP 403 denied'), 'policy');
  assert.equal(failureClass('HTTP 503 overload'), 'network');
});
