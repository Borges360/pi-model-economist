import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveInputCost, effectiveCost, callCost, providerEconomics } from '../economics/cost.mjs';
import { CacheLedger, normalizeCacheUsage, structuralKey, toolsHash } from '../economics/cache.mjs';
import { EconomicsObserver, HostCapabilitiesProbe } from '../context/observer.mjs';
import { economicsEvent } from '../observability/events.mjs';
import { assess, defaults } from '../routing.mjs';
import { rankActions } from '../decision.mjs';

const model = { provider: 'p', id: 'm', cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12 }, cacheRetentionMs: 60000,
  tier: 3, tools: true, contextWindow: 200000, reasoning: false };
test('effective cost decomposes input once and never coerces missing measurements to zero', () => {
  const input = { uncached: 1000, cacheRead: 2000, cacheWrite: 500 };
  assert.ok(Math.abs(effectiveInputCost(input, model.cost).usd - 0.018) < 1e-12);
  const cost = effectiveCost({ input, outputTokens: 100, prices: model.cost, classifier: 0.001, recovery: 0.01 });
  assert.ok(Math.abs(cost.usd - 0.031) < 1e-12);
  assert.equal(effectiveInputCost({ uncached: 0, cacheRead: 20, cacheWrite: 0 }, { input: 1 }).usd, null);
  assert.equal(effectiveCost({ input, outputTokens: 100, prices: {} }).usd, null);
  assert.equal(providerEconomics({ provider: 'other', cost: { input: 0, output: 0 } }).prices.input, null);
  assert.equal(providerEconomics(model).retentionMs, 60000);
  assert.equal(providerEconomics({ cost: model.cost }).retentionMs, null);
});
test('provider usage adapters normalize inclusive/exclusive input without inventing write counts or TTL', () => {
  const pi = normalizeCacheUsage({ input: 100, cacheRead: 900, cacheWrite: 200 });
  assert.equal(pi.inputTokens, 1200); assert.equal(pi.hitRatio, 0.75);
  const openai = normalizeCacheUsage({ input_tokens: 1000, input_tokens_details: { cached_tokens: 900 } }, { format: 'openai' });
  assert.equal(openai.uncachedInputTokens, 100); assert.equal(openai.cacheWriteTokens, null);
  const anthropic = normalizeCacheUsage({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 200 }, { format: 'anthropic' });
  assert.equal(anthropic.inputTokens, 1200);
  assert.equal(normalizeCacheUsage({}).hitRatio, null);
  assert.equal(normalizeCacheUsage({ input: 100 }).inputTokens, null);
});
test('cache keys are deterministic and match full tool schemas, never raw content', () => {
  const a = [{ name: 'z', parameters: { type: 'object' } }, { name: 'a', description: 'first' }];
  assert.equal(toolsHash(a), toolsHash([...a].reverse()));
  assert.notEqual(toolsHash(a), toolsHash([{ name: 'z', parameters: { type: 'string' } }, a[1]]));
  const key = structuralKey({ provider: 'p', model: 'm', systemVersion: 'v1', toolsManifestHash: toolsHash(a) });
  assert.ok(!key.includes('first')); assert.equal(key.length, 64);
});
test('cache forecast abstains with unknown retention and uses only matching prefix evidence', () => {
  const ledger = new CacheLedger();
  ledger.observe(normalizeCacheUsage({ input: 100, cacheRead: 900, cacheWrite: 0 }, { provider: 'p', model: 'p/m', scopeKey: 'key' }));
  assert.equal(ledger.predict(model, 'key').probability, 1);
  assert.equal(ledger.predict({ ...model, cacheRetentionMs: undefined }, 'key').probability, null);
  assert.equal(ledger.predict(model, 'different').probability, null);
  const forecast = ledger.forecast(model, 'key', { inputTokens: 1000, outputTokens: 100 });
  assert.equal(forecast.cachedTokens, 900); assert.ok(forecast.usd < 0.012);
  assert.equal(ledger.predict(model, 'key', Date.now() + 120000).probability, 0);
});
test('ranker includes cache inside request cost, with no second savings subtraction', () => {
  const ledger = new CacheLedger();
  ledger.observe(normalizeCacheUsage({ input: 100, cacheRead: 900, cacheWrite: 0 }, { model: 'p/m', scopeKey: 'key' }));
  const result = rankActions([model], assess('hello'), defaults.modelEconomist,
    { economics: { ledger, scopeKey: () => 'key', plan: { overheadUsd: { retrieval: 0, compaction: 0, handoff: 0 } } } });
  const action = result.accepted[0]; assert.ok(action);
  assert.equal(action.policyCostUsd, action.predictedCostUsd);
  assert.equal(action.costBreakdown.cacheAccounting, 'included-in-input');
  assert.equal(action.baseCostUsd, action.cacheForecast.usd);
});
test('observer separates host price derivation, provider billed cost, unknown usage and measured cache reads', () => {
  const observer = new EconomicsObserver();
  assert.equal(observer.report().cacheHitRate, null); assert.equal(observer.report().actualCostUsd.value, null);
  const message = { provider: 'p', model: 'm', responseId: '1', usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 10, cost: { total: 0 } } };
  observer.observeCall(message, model, { routeId: 'r' });
  observer.observeCall(message, model); // Idempotent duplicate host delivery.
  assert.equal(observer.calls.length, 1);
  const report = observer.report([{ id: 'o', taskId: 't', decisionId: 'r', success: true }]);
  assert.equal(report.estimatedCostUsd.value, 0); assert.equal(report.actualCostUsd.value, null);
  assert.equal(report.cacheHitRate, 1); assert.equal(report.cachedTokenFraction, 0.9); assert.equal(report.cpvs, 0); assert.equal(report.contextYield, null);
  assert.equal(callCost({ billedCostUsd: 0.2 }, model).actualCost.provenance, 'observed');
});

test('cache hit frequency differs from token fraction and exposes missing observations', () => {
  const observer = new EconomicsObserver();
  for (const [responseId, usage] of [['hit', { input: 100, cacheRead: 900, cacheWrite: 0 }],
    ['miss', { input: 100, cacheRead: 0, cacheWrite: 0 }], ['unknown', { input: 100 }]]) {
    observer.observeCall({ provider: 'p', model: 'm', responseId, usage }, model);
  }
  const report = observer.report();
  assert.equal(report.cacheHitRate, 0.5);
  assert.equal(report.cacheHitSamples, 2); assert.equal(report.cacheUnknownSamples, 1);
  assert.equal(report.cachedTokenFraction, null);
  observer.calls.pop();
  assert.equal(observer.report().cachedTokenFraction, 900 / 1100);
});

test('tool output accounting replaces repeated transcript observations and counts small retained results', () => {
  const observer = new EconomicsObserver();
  observer.observeOutput({ id: 'large', retainedTokens: 30, externalizedTokens: 970 });
  observer.observeOutput({ id: 'large', retainedTokens: 30, externalizedTokens: 970 });
  observer.observeOutput({ id: 'small', retainedTokens: 10, externalizedTokens: 0 });
  assert.equal(observer.outputs.length, 2);
  assert.equal(observer.report().retainedTokens, 40); assert.equal(observer.report().externalizedTokens, 970);
  observer.observeOutput({ id: 'large', retainedTokens: 1000, externalizedTokens: 0 });
  assert.equal(observer.report().retainedTokens, 1010); assert.equal(observer.report().externalizedTokens, 0);
});
test('versioned events whitelist metadata and capability probes distinguish registration from observation', () => {
  const event = economicsEvent('cache.observed', { inputTokens: 2, prompt: 'private', toolOutput: 'private', sourceCode: 'private', cacheKeyHash: 'hash' });
  assert.equal(event.eventVersion, 2); assert.deepEqual(Object.keys(event.payload).sort(), ['cacheKeyHash', 'inputTokens']);
  assert.ok(!JSON.stringify(event).includes('private'));
  const probe = new HostCapabilitiesProbe({ registerTool() {} }, {});
  assert.equal(probe.capabilities.context, 'unknown'); assert.equal(probe.capabilities.compact, 'unavailable');
  probe.observed('context'); assert.equal(probe.capabilities.context, 'observed');
});
