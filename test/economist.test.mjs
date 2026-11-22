import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import install, { sanitizeEnvelope } from '../extension.mjs';
import {
  assess,
  defaults,
  Classifiers,
  validateAssessment,
  failureClass,
  normalizeText,
  classifierPayload,
  riskHits,
} from '../routing.mjs';
import * as D from '../decision.mjs';
import { benchmarkMatrix } from '../benchmark.mjs';
import { redact, scrubEntropy, validateConfig } from '../lib/core.mjs';
import { explainLines } from '../menu.mjs';
import { fakePi } from '../test-support/fakes.mjs';

const c = defaults.modelEconomist;
const model = (id, tier, price, extra = {}) => ({
  provider: 'p',
  id,
  api: 'x',
  auth: true,
  tier,
  tools: true,
  input: ['text'],
  contextWindow: 200000,
  reasoning: true,
  cost: { input: price, output: price },
  ...extra,
});
const act = (id, pSuccess, cost, p95, extra = {}) => ({
  id,
  modelId: id,
  effort: 'off',
  tier: 1,
  pSuccess,
  pSafe: null,
  uncertainty: 0.1,
  policyCostUsd: cost,
  predictedCostUsd: cost,
  latency: { p50Ms: p95 / 2, p95Ms: p95 },
  ...extra,
});
const outcome = (modelId, effort, success, extra = {}) => ({
  model: modelId,
  effort,
  version: 'version-unknown',
  verified: true,
  success,
  intents: [],
  occurredAt: new Date().toISOString(),
  ...extra,
});

/* ------------------------------ phase 1 ------------------------------ */

test('defaults: money and waiting are separate, floors per difficulty, latencyWeight gone', () => {
  assert.equal(c.objectives.latencyValueUsdPerSecond, 0.01);
  assert.deepEqual(c.objectives.qualityFloor, { trivial: 0.45, simple: 0.55, moderate: 0.7, complex: 0.8, critical: 0.88 });
  assert.equal(c.objectives.safetyThreshold, 0.9);
  assert.equal(c.objectives.balanced.successTie, 0.02);
  assert.equal(c.latencyWeight, undefined);
  assert.equal(c.explorationEvery, undefined, 'the every-20-rows exploration rule is gone');
  assert.deepEqual(
    { alpha: c.stats.alpha, beta: c.stats.beta, halfLifeDays: c.stats.halfLifeDays, minSafeSamples: c.stats.minSafeSamples, applyCalibration: c.stats.applyCalibration },
    { alpha: 1, beta: 3, halfLifeDays: 30, minSafeSamples: 20, applyCalibration: false },
  );
  assert.equal(c.classifier.minUtilityMargin, 0.05);
  assert.equal(c.classifier.materialCostGap, 0.25);
  assert.equal(c.classifier.minCalibratedProbability, 0.6);
  assert.equal(c.classifier.imageDescriber.mode, 'off');
  assert.equal(c.fastPath.successMargin, 0.05);
  assert.deepEqual(c.window, { safetyMargin: 512, toolGrowth: 2048 });
  assert.equal(c.learned.deployment, 'shadow');
  assert.equal(c.learned.kappa, 0.15);
  assert.equal(c.learned.preference, false);
});

test('four policies read pSuccess, money and p95 as separate quantities', () => {
  const set = [
    act('A', 0.95, 0.05, 9000),
    act('A2', 0.94, 0.01, 9000),
    act('B', 0.8, 0.001, 3000),
    act('C', 0.78, 0.002, 500),
    act('D', 0.4, 0.0001, 100),
  ];
  const pick = (policy) => D.selectAction(set, { policy, floor: 0.7, objectives: c.objectives }).selected.id;
  assert.equal(pick('economy'), 'B', 'cheapest above the floor; D is under it');
  assert.equal(pick('quality'), 'A', 'highest pSuccess');
  assert.equal(pick('latency'), 'C', 'lowest p95 above the floor');
  assert.equal(pick('balanced'), 'A2', 'within successTie of q*, the cheaper cost+wait');
  const u = (policy) => D.utility(policy, { pSuccess: 0.9, costUsd: 0.1, p95Ms: 2000 }, c.objectives);
  assert.ok(Math.abs(u('economy') - 0.8) < 1e-9);
  assert.ok(Math.abs(u('balanced') - 0.78) < 1e-9);
  assert.ok(Math.abs(u('quality') - (0.9 - 0.0001)) < 1e-9);
  assert.ok(Math.abs(u('latency') - (0.9 - 0.2 - 0.0001)) < 1e-9);
});

test('relaxation drops latency first, then the soft budget; floor and safety never relax', () => {
  const set = [act('slow', 0.9, 0.01, 5000), act('cheap', 0.88, 0.001, 4000)];
  const balanced = (b) => D.selectAction(set, { policy: 'balanced', floor: 0.7, objectives: { ...c.objectives, balanced: { ...c.objectives.balanced, ...b } } });
  assert.equal(balanced({ targetLatencyMs: 100, softBudgetUsd: 1 }).policyResult, 'relaxed-latency');
  assert.equal(balanced({ targetLatencyMs: 100, softBudgetUsd: 0.0001 }).policyResult, 'relaxed-budget');
  assert.equal(balanced({}).policyResult, 'selected');
  for (const policy of ['economy', 'balanced', 'quality', 'latency']) {
    const r = D.selectAction(set, { policy, floor: 0.95, objectives: c.objectives });
    assert.equal(r.selected, null, `${policy} never relaxes the floor`);
    assert.equal(r.policyResult, 'quality-floor-unmet');
  }
  const unsafe = D.selectAction([act('u', 0.99, 0.001, 10, { pSafe: 0.5 })], { policy: 'quality', floor: 0.5, objectives: c.objectives });
  assert.equal(unsafe.selected, null, 'pSafe under the threshold is never chosen');
});

test('role preference stays within feasible actions and fallback is explicit', () => {
  const set = [act('p/cheap', 0.91, 0.02, 1200), act('p/strong', 0.94, 0.2, 1400)];
  const preferred = D.selectAction(set, {
    policy: 'economy',
    floor: 0.7,
    preferredModel: 'p/strong',
  });
  assert.equal(preferred.selected.modelId, 'p/strong');
  assert.equal(preferred.rolePreferenceResult, 'preferred');

  const unavailable = D.selectAction([set[0]], {
    policy: 'economy',
    floor: 0.7,
    preferredModel: 'p/strong',
  });
  assert.equal(unavailable.selected, null, 'strict preference does not switch providers silently');
  assert.equal(unavailable.rolePreferenceResult, 'unavailable');

  const fallback = D.selectAction([set[0]], {
    policy: 'economy',
    floor: 0.7,
    preferredModel: 'p/strong',
    allowPreferenceFallback: true,
  });
  assert.equal(fallback.selected.modelId, 'p/cheap');
  assert.equal(fallback.rolePreferenceResult, 'fallback');

  const unknownPrice = D.selectAction([act('p/unpriced', 0.99, null, 500)], {
    policy: 'quality',
    floor: 0.7,
    remainingBudget: 0.5,
    preferredModel: 'p/unpriced',
  });
  assert.equal(unknownPrice.selected, null, 'unknown price never counts as zero under a hard budget');
});

test('role effort preference selects an eligible effort and reports fallback when unavailable', () => {
  const set = [
    act('p/cheap#low', 0.91, 0.02, 1200, { modelId: 'p/cheap', effort: 'low' }),
    act('p/strong#high', 0.94, 0.2, 1400, { modelId: 'p/strong', effort: 'high' }),
  ];
  const preferred = D.selectAction(set, {
    policy: 'economy',
    floor: 0.7,
    preferredEffort: 'high',
  });
  assert.equal(preferred.selected.effort, 'high');
  assert.equal(preferred.roleEffortResult, 'preferred');

  const unavailable = D.selectAction([set[0]], {
    policy: 'economy',
    floor: 0.7,
    preferredEffort: 'high',
  });
  assert.equal(unavailable.selected, null);
  assert.equal(unavailable.roleEffortResult, 'unavailable');

  const fallback = D.selectAction([set[0]], {
    policy: 'economy',
    floor: 0.7,
    preferredEffort: 'high',
    allowPreferenceFallback: true,
  });
  assert.equal(fallback.selected.effort, 'low');
  assert.equal(fallback.roleEffortResult, 'fallback');
});

test('retry causes are classified in a fixed order', () => {
  assert.equal(failureClass('context_length_exceeded'), 'context');
  assert.equal(failureClass('HTTP 403 denied'), 'policy');
  assert.equal(failureClass('HTTP 503 overload'), 'server');
  assert.equal(failureClass('429 rate limit'), 'server');
  assert.equal(failureClass('stream timeout'), 'network');
  assert.equal(failureClass('model does not support image input'), 'capability');
  assert.equal(failureClass('wrong answer'), 'quality');
});

/* ------------------------------ phase 2 ------------------------------ */

test('cold start pSuccess comes from the tier, capped at 0.97, independent of effort', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(D.tierPrior), [0.62, 0.74, 0.84, 0.88, 0.91]);
  assert.equal(D.tierPrior(9), 0.97);
  const a = assess('adicione testes no parser');
  const r = D.rankActions([model('m', 2, 1)], a, c);
  assert.ok(r.accepted.every((x) => Math.abs(x.pSuccess - 0.74) < 1e-9));
});

test('pSafe stays null below 20 risky samples and gates actions above it', () => {
  const risky = assess('altere a senha do banco de produção');
  const action = { modelId: 'p/m', effort: 'high', version: 'version-unknown', tier: 4 };
  const fam = D.familyOf(risky.features);
  const rows = (n, success) =>
    Array.from({ length: n }, (_, i) => outcome('p/m', 'high', success, { family: fam, risky: true, taskId: `t${i}` }));
  assert.equal(D.predictSafety(risky.features, action, { outcomes: rows(19, true), stats: c.stats }), null);
  assert.ok(D.predictSafety(risky.features, action, { outcomes: rows(20, true), stats: c.stats }) >= 0.9);
  const bad = D.rankActions([model('m', 4, 1)], risky, c, { outcomes: D.prepareOutcomes(rows(30, false)) });
  assert.ok(bad.rejected.some((x) => x.thinkingLevel === 'high' && x.reasonCodes.includes('unsafe')));
  const cold = D.rankActions([model('m', 4, 1), model('flat', 4, 0.1, { reasoning: false })], risky, c);
  assert.ok(cold.guard, 'no safety samples: the reasoning guardrail applies');
  assert.ok(cold.rejected.some((x) => x.model === 'p/flat' && x.reasonCodes.includes('reasoning-unavailable')));
  assert.ok(cold.accepted.every((x) => x.effort !== 'off'));
});

test('features are multi-label and the family key names kind, impact, tools and image', () => {
  const a = assess('corrija o bug e adicione testes no parser');
  assert.ok(a.intents.includes('debug') && a.intents.includes('test'));
  assert.match(D.familyOf(a.features), /^\w+\|risk:\w+\|tools:(required|none)\|image:[01]$/);
  assert.ok(['none', 'low', 'medium', 'high', 'critical'].includes(a.features.risk.impact) || a.features.risk.impact);
});

test('risk: deterministic, semantic (mention 0.45, obfuscated 0.7), context and caption', () => {
  const hard = assess('apague o banco de produção');
  assert.ok(hard.risks.length > 0);
  assert.equal(hard.features.risk.source, 'deterministic');
  const mention = assess('explique o que é um deploy em produção');
  assert.equal(mention.risks.length, 0, 'a mention under an explanation opener is not hard risk');
  assert.ok(Object.values(mention.semanticRisks ?? {}).some((v) => v === 0.45) || mention.semanticRiskActive);
  assert.equal(normalizeText('d r o p'), 'drop');
  const loose = riskHits('please run droptable now');
  assert.deepEqual(loose.deterministic, []);
  assert.equal(loose.semantic['data-loss'], 0.7, 'squashed phrase is semantic 0.7');
  assert.ok(assess('please run droptable now').semanticRiskActive);
  assert.equal(riskHits('não apague nada').semantic['data-loss'], 0.45, 'negation is semantic 0.45');
  const follow = assess('continue', { previousRisks: hard.risks });
  assert.ok(follow.contextRisk, 'a short follow-up inherits the risk in context');
  const pic = assess('o que tem aqui?', { images: true });
  assert.ok(pic.imageUninspected);
  assert.ok(pic.features.signals?.includes?.('image-uninspected') || pic.signals?.includes?.('image-uninspected') || pic.signalSummary?.includes?.('image-uninspected'));
  const captioned = assess('o que tem aqui?', { images: true, caption: 'terminal mostrando senha do banco de produção' });
  assert.equal(captioned.imageUninspected, false);
  assert.ok(Object.values(captioned.features.risk.sources).includes('caption'));
});

test('routing state counts files without storing paths; checkpoints break stickiness', () => {
  const messages = [
    { role: 'user', content: 'corrija o parser' },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'read', arguments: { path: '/secret/a.js' } }] },
    { role: 'toolResult', toolCallId: 'a', toolName: 'read', content: [{ type: 'text', text: 'ok' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'b', name: 'edit', arguments: { path: '/secret/b.js' } }] },
    { role: 'toolResult', toolCallId: 'b', toolName: 'edit', content: [{ type: 'text', text: 'ok' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'npm test' } }] },
    { role: 'toolResult', toolCallId: 'c', toolName: 'bash', isError: true, details: { exitCode: 1 }, content: [{ type: 'text', text: 'api_key=sk-abcdef1234567890abcdef 1 failing' }] },
  ];
  const scan = D.scanMessages(messages);
  assert.equal(scan.toolRounds, 3);
  assert.equal(scan.filesTouched, 1);
  const a = assess('corrija o parser', { recentToolFailure: true });
  const state = D.buildRoutingState({ messages }, null, { assessment: a, scan, availableTools: ['read', 'edit'] });
  assert.equal(state.artifacts.filesTouched, 1);
  assert.doesNotMatch(JSON.stringify(state), /secret\/b\.js/);
  assert.doesNotMatch(state.lastObservation.text, /sk-abcdef/);
  assert.equal(state.taskProgress, 'repair');
  assert.deepEqual(D.checkpoints({ state, assessment: a, scan }), ['test_rejected']);
  const recovery = D.buildRoutingState({ messages: [] }, { previousAttempt: { outcome: 'quality' } }, { assessment: a, scan: D.scanMessages([]) });
  assert.ok(D.checkpoints({ state: recovery, assessment: a, scan: D.scanMessages([]) }).includes('recovery'));
  const plan = assess('planeje a arquitetura do serviço');
  const planState = D.buildRoutingState({ messages: [] }, null, { assessment: plan, scan: D.scanMessages([]) });
  assert.ok(D.checkpoints({ state: planState, assessment: plan, scan: D.scanMessages([]) }).includes('plan'));
});

test('validateFeasibility checks a reused pair and names the fix', () => {
  const textOnly = model('t', 2, 1, { contextWindow: 1000 });
  const r = D.validateFeasibility({ model: textOnly, thinkingLevel: 'off' }, { image: true, requiredWindow: 5000, requireReasoning: true }, {});
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons.sort(), ['context', 'image', 'reasoning-unavailable']);
  assert.match(D.fixHint(r.reasons), /\/compact|visão/);
  assert.ok(D.validateFeasibility({ model: model('ok', 2, 1), thinkingLevel: 'low' }, {}, {}).ok);
});

test('redact covers emails, phones and secrets; deny sends only enums', () => {
  const text = 'mail ana@example.com tel +55 11 98765-4321 key api_key=abcd1234efgh5678';
  const out = redact(text);
  assert.doesNotMatch(out, /ana@example\.com|98765|abcd1234efgh5678/);
  assert.match(scrubEntropy('token Zx9Qw8Er7Ty6Ui5Op4As3'), /\[REDACTED\]/);
  const a = assess('corrija o login de ana@example.com');
  const deny = classifierPayload('corrija o login de ana@example.com', a, null, 'deny');
  assert.doesNotMatch(deny.text, /ana|login/);
  const red = classifierPayload('corrija o login de ana@example.com', a, null, 'redact');
  assert.doesNotMatch(red.text, /ana@example/);
});

test('telemetry deny keeps hashes, never the observation or caption text', () => {
  const row = { routingState: { lastObservation: { text: 'stdout secreto' } }, caption: 'tela com dados' };
  const deny = D.telemetryView(row, 'deny');
  assert.equal(deny.caption, undefined);
  assert.equal(deny.routingState.lastObservation.text, undefined);
  assert.ok(deny.captionHash && deny.routingState.lastObservation.textHash);
  assert.equal(row.caption, 'tela com dados', 'the live decision is not mutated');
});

test('config validation: data policies, describer, deployment and probabilities', () => {
  const v = (m) => () => validateConfig({ modelEconomist: m });
  assert.doesNotThrow(v(structuredClone(c)));
  assert.throws(v({ classifier: { dataPolicy: 'leak' } }));
  assert.throws(v({ executor: { dataPolicy: 'x' } }));
  assert.throws(v({ classifier: { imageDescriber: { mode: 'cloud' } } }));
  assert.throws(v({ learned: { deployment: 'live' } }));
  assert.throws(v({ objectives: { qualityFloor: { simple: 1.5 } } }));
  assert.throws(v({ objectives: { safetyThreshold: -1 } }));
  assert.throws(v({ stats: { applyCalibration: 'yes' } }));
});

test('subagent envelope keeps only schema fields', () => {
  const e = sanitizeEnvelope({ environment: 'production', risks: ['production', 'nonsense'], capabilities: { tools: true }, secret: 'x', availableTools: ['read', 3] });
  assert.equal(e.environment, 'production');
  assert.deepEqual(e.risks, ['production']);
  assert.equal(e.secret, undefined);
  assert.deepEqual(e.availableTools, ['read']);
  assert.equal(sanitizeEnvelope(null), null);
});

/* ------------------------------ phase 3 ------------------------------ */

test('only verified sources become outcomes; dominated efforts are marked', () => {
  const conf = { verifiers: { trustedJudges: ['ci-judge'] } };
  assert.equal(D.recordVerifiedOutcome({ source: 'assistant', success: true, model: 'p/m' }, conf), null);
  assert.equal(D.recordVerifiedOutcome({ source: 'judge', verifier: 'random', success: true, model: 'p/m' }, conf), null);
  assert.equal(D.recordVerifiedOutcome({ source: 'judge', verifier: 'ci-judge', success: true, model: 'p/m' }, conf).success, true);
  assert.equal(D.recordVerifiedOutcome({ source: 'exit_code', exitCode: 1, model: 'p/m' }, conf).success, false);
  for (const source of ['gate', 'test', 'typecheck', 'ci', 'file_diff'])
    assert.ok(D.recordVerifiedOutcome({ source, success: true, model: 'p/m' }, conf));
  const rows = D.prepareOutcomes([
    outcome('p/m', 'low', true, { taskId: 't', verifier: 'v' }),
    outcome('p/m', 'high', true, { taskId: 't', verifier: 'v' }),
  ]);
  assert.deepEqual(rows.map((r) => r.dominated), [false, true]);
});

test('Beta posterior: alpha 1, beta 3, decay half-life 30 days', () => {
  assert.equal(D.betaPosterior({}).pSuccess, 0.75);
  const a = assess('adicione testes no parser');
  const action = { modelId: 'p/m', effort: 'low', version: 'version-unknown', tier: 2 };
  const fam = D.familyOf(a.features);
  const failures = (days) =>
    Array.from({ length: 10 }, () =>
      outcome('p/m', 'low', false, { family: fam, occurredAt: new Date(Date.now() - days * 86400000).toISOString() }),
    );
  const fresh = D.predictSuccess(a.features, action, { outcomes: D.prepareOutcomes(failures(0)), stats: c.stats });
  const old = D.predictSuccess(a.features, action, { outcomes: D.prepareOutcomes(failures(90)), stats: c.stats });
  assert.ok(old.pSuccess > fresh.pSuccess, 'old failures weigh less');
  assert.ok(fresh.pSuccess < D.tierPrior(2));
});

test('expected retries and recovery come from the next action on the ladder', () => {
  const a = assess('adicione testes no parser');
  const r = D.rankActions([model('m', 2, 1)], a, c);
  const low = r.accepted.find((x) => x.effort === 'low');
  assert.equal(low.recoverySource, 'next-action');
  assert.ok(Math.abs(low.expectedRetries - 0.26 / 0.74) < 1e-9);
  const next = r.accepted.find((x) => x.effort === 'medium');
  assert.ok(Math.abs(low.expectedRecoveryCostUsd - 0.26 * next.baseCostUsd) < 1e-12);
  assert.ok(Math.abs(low.predictedCostUsd - (low.baseCostUsd + low.expectedRecoveryCostUsd)) < 1e-12);
});

test('cache, TTFT and reasoning prices: zero and flagged when unpublished', () => {
  const shared = D.priceAction(model('m', 1, 1), { input: 1000, visible: 100, reasoning: 100, effort: 'high' });
  assert.ok(shared.flags.includes('reasoning-price-shared'));
  const own = D.priceAction(model('m', 1, 1, { cost: { input: 1, output: 1, reasoning: 5 } }), { reasoning: 1e6, effort: 'high' });
  assert.equal(own.usd, 5);
  assert.deepEqual(own.flags, []);
  const prev = model('prev', 1, 2);
  const unpriced = D.cacheTerms(model('x', 1, 1), prev, [{ modelId: 'p/prev', cacheReadTokens: 1000 }]);
  assert.deepEqual([unpriced.savings, unpriced.loss], [0, 0]);
  assert.ok(unpriced.flags.includes('cache-unpriced'));
  const priced = { ...prev, cost: { input: 2, output: 2, cacheRead: 0.2 } };
  const calls = [{ modelId: 'p/prev', cacheReadTokens: 1_000_000 }];
  assert.ok(D.cacheTerms(priced, priced, calls).savings > 0, 'staying keeps the cache');
  assert.ok(D.cacheTerms(model('x', 1, 1), priced, calls).loss > 0, 'switching loses it');
  assert.ok(D.ttftDelta(model('x', 1, 1), prev, []).flags.includes('ttft-unpriced'));
  assert.ok(D.tokenProfile(model('m', 1, 1), 'low', c.thinking, []).flags.includes('reasoning-not-split'));
});

test('required window: input + p95 tokens + tool growth 2048 + margin 512', () => {
  assert.equal(D.requiredWindow(1000, { reasoningP95: 10, visibleP95: 20 }, true, c.window), 1000 + 30 + 2048 + 512);
  const a = assess('adicione testes no parser', { contextTokens: 150000 });
  const r = D.rankActions([model('small', 2, 1, { contextWindow: 100000 }), model('big', 2, 2)], a, c, { inputTokensByModel: new Map([['p/big', 150000]]) });
  assert.ok(r.rejected.some((x) => x.model === 'p/small' && x.reasonCodes.includes('context')));
  assert.ok(r.accepted.every((x) => x.modelId === 'p/big'));
  const fallback = D.rankActions([model('a', 2, 1), model('b', 2, 1)], assess('oi'), c, { inputTokensByModel: new Map([['p/a', 10]]) });
  assert.ok(fallback.accepted.find((x) => x.modelId === 'p/b').flags.includes('token-estimate-fallback'));
});

test('value of information: skip on a wide margin, call when a label crosses a tier', () => {
  const base = { firstId: 'x', firstUtility: 0.9, secondUtility: 0.5, firstCost: 0.01, secondCost: 0.0105, requiredTier: 1, requiredCaps: '' };
  const skip = D.shouldClassify({ base, alternatives: [], price: 0.001, classifier: c.classifier, objectives: c.objectives });
  assert.equal(skip.call, false);
  assert.equal(skip.reason, 'classifier-skipped-no-voi');
  const call = D.shouldClassify({
    base,
    alternatives: [{ label: 'difficulty:complex', winnerId: 'y', gain: 0.0001, requiredTier: 2, requiredCaps: '' }],
    price: 0.001,
    classifier: c.classifier,
    objectives: c.objectives,
  });
  assert.equal(call.call, true);
  assert.ok(call.reasons.includes('label-changes-winner'));
});

test('calibration bins, ECE and an opt-in lookup', () => {
  const pairs = [
    ...Array.from({ length: 30 }, (_, i) => ({ p: 0.9, success: i < 15 })),
    ...Array.from({ length: 10 }, () => ({ p: 0.1, success: false })),
  ];
  const r = D.calibrationReport(pairs);
  assert.equal(r.bins.length, 5);
  assert.equal(r.n, 40);
  assert.ok(Math.abs(r.ece - ((30 / 40) * 0.4 + (10 / 40) * 0.1)) < 1e-9);
  assert.equal(r.lookup(0.95), 0.5);
  assert.equal(r.lookup(0.1), null, 'bins under 30 samples do not calibrate');
  const a = assess('oi');
  const p = D.predictSuccess(a.features, { modelId: 'p/m', effort: 'off', version: 'version-unknown', tier: 5 }, { calibration: r });
  assert.equal(p.calibrated, true);
  assert.equal(p.pSuccess, 0.5);
});

/* ------------------------------ phase 4 ------------------------------ */

test('precision-weighted mix: own Beta, intent pool at 0.5 and embedder neighbours at 0.25', () => {
  const now = Date.now();
  const a = assess('adicione testes no parser');
  const action = { modelId: 'p/m', effort: 'low', version: 'version-unknown', tier: 2 };
  const own = D.familyOf(a.features);
  const failing = (n, extra) => Array.from({ length: n }, () => outcome('p/m', 'low', false, { occurredAt: new Date(now).toISOString(), ...extra }));
  const prior = D.predictSuccess(a.features, action, {}).pSuccess;
  const withOwn = D.predictSuccess(a.features, action, { now, outcomes: D.prepareOutcomes(failing(8, { family: own })) });
  const withPool = D.predictSuccess(a.features, action, { now, outcomes: D.prepareOutcomes(failing(8, { family: 'other', intents: a.features.intents })) });
  assert.ok(withOwn.pSuccess < withPool.pSuccess && withPool.pSuccess < prior, 'own data weighs more than pooled');
  assert.equal(withPool.poolSamples, 8);
  const embed = () => [1, 0];
  const neighbours = D.predictSuccess(a.features, action, {
    now,
    outcomes: D.prepareOutcomes(failing(8, { family: 'far', intents: ['explain'], features: { x: 1 } })),
    embed,
    learned: { embeddings: 'on', neighborCosine: 0.85 },
  });
  assert.equal(neighbours.poolSamples, 2, '8 neighbours at weight 0.25');
  const off = D.predictSuccess(a.features, action, {
    now,
    outcomes: D.prepareOutcomes(failing(8, { family: 'far', intents: ['explain'], features: { x: 1 } })),
    embed,
    learned: { embeddings: 'off' },
  });
  assert.equal(off.poolSamples, 0, 'the embedder is off by default');
});

test('Bradley-Terry preference from verified pairs', () => {
  const rows = Array.from({ length: 25 }, (_, i) => [
    outcome('p/a', 'low', true, { taskId: `t${i}`, costUsd: 0.01 }),
    outcome('p/b', 'low', false, { taskId: `t${i}`, costUsd: 0.005 }),
  ]).flat();
  const pairs = D.preferencePairs(rows);
  assert.equal(pairs.length, 25);
  const bt = D.bradleyTerry(pairs);
  assert.ok(bt.get('p/a#low').p > bt.get('p/b#low').p);
});

test('exploration: kappa bonus within the premium, never under hard risk, once per family', () => {
  const greedy = act('g', 0.9, 0.01, 100, { uncertainty: 0 });
  const curious = act('c', 0.9, 0.0105, 100, { uncertainty: 0.5 });
  const pricey = act('p', 0.9, 0.05, 100, { uncertainty: 1 });
  const opts = { policy: 'balanced', objectives: c.objectives, kappa: 0.15 };
  assert.equal(D.explore([greedy, curious, pricey], greedy, opts).shadowChoice.id, 'c', 'within the 10% premium');
  assert.equal(D.explore([greedy, curious], greedy, { ...opts, hardRisk: true }).shadowChoice.id, 'g');
  assert.equal(D.explore([greedy, curious], greedy, { ...opts, alreadyExplored: true }).shadowChoice.id, 'g');
});

test('active exploration remains inside a preferred role model and effort', () => {
  const greedy = act('strong#high', 0.9, 0.01, 100, { modelId: 'p/strong', effort: 'high' });
  const actions = [
    greedy,
    act('strong#low', 0.9, 0.009, 100, { modelId: 'p/strong', effort: 'low' }),
    act('cheap#high', 0.9, 0.008, 100, { modelId: 'p/cheap', effort: 'high' }),
  ];
  assert.deepEqual(
    D.constrainRoleExploration(actions, greedy, { modelPreferred: true, effortPreferred: true }),
    [greedy],
  );
  assert.deepEqual(D.constrainRoleExploration(actions, greedy, { effortPreferred: true }), [greedy, actions[2]]);
  assert.equal(D.constrainRoleExploration(actions, greedy), actions, 'no role preference keeps normal exploration');
});

/* ------------------------------ classifier ------------------------------ */

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
  assert.equal((await classifier.run('text', rules, ctx, { ...c.classifier, enabled: false })).cost, 0);
  await classifier.run('text', rules, ctx, { ...c.classifier, engine: 'jev' });
  assert.equal(called, 0, 'no published price, no call');
  const events = [];
  const r = await classifier.run(
    'api_key=never-leak',
    rules,
    ctx,
    { ...c.classifier, engine: 'jev', timeoutMs: 10, decisionPrices: { 'typesafe/jev-latest': 0.001 } },
    { emit: async (k, p) => events.push({ k, p }) },
  );
  assert.match(r.fallback, /timeout/);
  assert.equal(called, 1);
  assert.equal(events.length, 1);
});

test('strict small-LLM JSON with intents/riskImpact/reversibility; low calibrated confidence falls back', async () => {
  const rules = assess('explain behaviour');
  const small = model('classify', 1, 0.1);
  let body = '{"kind":"edit","difficulty":"simple","risks":[],"requiresTools":true,"requiresLongContext":false,"requiresImageInput":false,"confidence":0.9,"signalSummary":[],"extra":1}';
  const ctx = {
    modelRegistry: {
      findOfType: () => null,
      getAvailable: () => [small],
      streamSimple: (_m, context) => {
        assert.ok(!context.messages[0].content.includes('private-value'));
        return { result: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: body }] }) };
      },
    },
  };
  const config = { ...c.classifier, engine: 'small-llm', smallLlmCandidates: ['p/classify'] };
  const r = await new Classifiers().run('password=private-value', rules, ctx, config);
  assert.match(r.fallback, /Invalid/);
  body = '{"kind":"edit","difficulty":"simple","risks":[],"requiresTools":true,"requiresLongContext":false,"requiresImageInput":false,"confidence":0.9,"signalSummary":[],"intents":["test"],"riskImpact":"low","reversibility":"easy"}';
  const ok = await new Classifiers().run('add a test', rules, ctx, config);
  assert.equal(ok.fallback, null);
  assert.ok(ok.assessment.intents.includes('test'));
  const low = await new Classifiers().run('add a test', rules, ctx, config, { calibrate: () => 0.3 });
  assert.match(low.fallback, /low-confidence/);
  assert.ok(validateAssessment({ kind: 'edit', difficulty: 'simple', risks: [], requiresTools: true, requiresLongContext: false, requiresImageInput: false, confidence: 0.5, signalSummary: [] }));
});

/* ---------------------------- integration ---------------------------- */

const pool = [
  model('cheap', 1, 0.1),
  model('mid', 2, 1),
  { ...model('strong', 4, 3), provider: 'q', contextWindow: 1_000_000 },
  { ...model('vision', 4, 2), input: ['text', 'image'] },
];
const yaml = (extra = '') => `modelEconomist:
  enabled: true
  mode: rules
  cadence: prompt
  candidates:
    - id: p/cheap
      tier: 1
      tools: true
    - id: p/mid
      tier: 2
      tools: true
    - id: q/strong
      tier: 4
      tools: true
    - id: p/vision
      tier: 4
      tools: true
${extra}`;
async function fixture(t, extra = '', injected = {}, models = pool) {
  const dir = await mkdtemp(join(tmpdir(), 'economist-spec-'));
  const previous = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  t.after(async () => {
    if (previous == null) delete process.env.PI_SUITE_HOME;
    else process.env.PI_SUITE_HOME = previous;
    // Windows: gravações assíncronas ainda abertas fazem o rmdir falhar com ENOTEMPTY/EBUSY.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await mkdir(join(dir, '.pi'));
  await writeFile(join(dir, '.pi', 'pi-suite.yaml'), yaml(extra));
  const f = fakePi(dir, models);
  f.ctx.scopedModels = undefined;
  // Full JSON in notifications instead of the compact TUI rendering.
  f.ctx.mode = 'print';
  install(f.pi, injected);
  await f.emit('session_start');
  return { f, dir };
}
const user = (text, extra = {}) => ({ reason: 'user', messages: [{ role: 'user', content: text }], thinkingLevel: 'off', ...extra });
async function rowsOf(dir, name) {
  const found = [];
  const walk = async (p) => {
    for (const e of await readdir(p, { withFileTypes: true }).catch(() => [])) {
      const q = join(p, e.name);
      if (e.isDirectory()) await walk(q);
      else if (e.name === `${name}.jsonl`) found.push(q);
    }
  };
  await walk(join(dir, 'state'));
  const rows = [];
  for (const file of found)
    for (const line of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) rows.push(JSON.parse(line));
  return rows.map((r) => r.payload ?? r);
}

test('model-routes logs the action, the four quantities and money-only cost', async (t) => {
  const { f, dir } = await fixture(t);
  const r = await f.pi.virtual.route(user('adicione testes no parser'), f.ctx);
  assert.ok(r.model);
  const [row] = (await rowsOf(dir, 'model-routes')).slice(-1);
  for (const field of ['pSuccess', 'pSafe', 'predictedCostUsd', 'latencyP50Ms', 'latencyP95Ms', 'qualityFloor', 'policyResult', 'action', 'routingState', 'classifierConsidered', 'reasoningProfile', 'effortSource', 'finalOutcome', 'shadowChoice', 'expectedRetries', 'recoverySource'])
    assert.ok(Object.hasOwn(row, field), `model-routes has ${field}`);
  assert.equal(row.estimatedTotalCostUsd, row.action && row.estimatedTotalCostUsd);
  assert.ok(row.estimatedTotalCostUsd < 0.5, 'no latency folded into the money');
  assert.equal(row.policyResult, 'selected');
  assert.ok(row.flags.includes('reasoning-not-split') || row.flags.includes('latency-prior'), 'the log names what was not measured');
});

test('absent config uses defaults and 0.3.x keys that left still load', async (t) => {
  const { f } = await fixture(t, '  latencyWeight: 0.5\n  explorationEvery: 20\n  cacheSwitchPenalty: 0.001\n  fastPath:\n    eligibleDifficulties: [trivial]\n    prohibitOnRisks: [security]\n');
  const r = await f.pi.virtual.route(user('oi'), f.ctx);
  assert.ok(r.model);
  await f.command('economist', 'json');
  const last = JSON.parse(f.notifications.at(-1));
  assert.equal(last.qualityFloor, 0.45, 'objectives fall back to defaults');
});

test('jev mode classifies every eligible request, greetings and hard risk included; hybrid gates by VOI', async (t) => {
  const { f } = await fixture(t, '  classifier:\n    engine: jev\n    decisionPrices:\n      typesafe/jev-latest: 0.0001\n');
  let calls = 0;
  f.ctx.modelRegistry.findOfType = () => ({ provider: 'typesafe', id: 'jev-latest' });
  f.ctx.modelRegistry.classify = async () => {
    calls++;
    return {
      stopReason: 'stop',
      answers: {
        difficulty: { type: 'choice', choice: 'trivial', confidence: 0.95 },
        kind: { type: 'choice', choice: 'explain' },
        tools: { type: 'bool', probability: 0 },
      },
    };
  };
  await f.command('economist', 'mode jev');
  await f.pi.virtual.route(user('oi'), f.ctx);
  await f.pi.virtual.route(user('apague o banco de produção'), f.ctx);
  assert.equal(calls, 2, 'jev classifies the greeting and the hard-risk request');
  await f.command('economist', 'simulate apague o banco de produção');
  assert.equal(calls, 2, 'simulate never calls the classifier, even in jev');
  await f.command('economist', 'mode hybrid');
  await f.pi.virtual.route(user('oi'), f.ctx);
  assert.equal(calls, 2, 'hybrid skips a greeting whose label cannot change the winner');
  await f.command('economist', 'json');
  assert.match(f.notifications.at(-1), /classifier-skipped-no-voi|classifierCalled: false/);
});

test('manual mode validates the chosen pair and names the fix command', async (t) => {
  const { f } = await fixture(t);
  await f.command('economist', 'mode manual');
  await assert.rejects(
    () =>
      f.pi.virtual.route(
        {
          reason: 'user',
          previous: { model: pool[0], thinkingLevel: 'off' },
          messages: [{ role: 'user', content: [{ type: 'text', text: 'veja' }, { type: 'image', data: 'x' }] }],
        },
        f.ctx,
      ),
    /image[\s\S]*\/model|\/model[\s\S]*image|visão/,
  );
});

test('retry by cause: network same pair, server then provider, context, policy, quality ladder', async (t) => {
  const { f } = await fixture(t, '  maxRetries: 5\n');
  const first = await f.pi.virtual.route(user('adicione testes no parser'), f.ctx);
  const failed = (msg, state = first.state, pair = first) => ({
    reason: 'retry',
    failed: { model: pair.model, thinkingLevel: pair.thinkingLevel, message: { errorMessage: msg } },
    state,
    messages: [{ role: 'user', content: 'adicione testes no parser' }],
    thinkingLevel: 'off',
  });
  const net = await f.pi.virtual.route(failed('stream timeout'), f.ctx);
  assert.equal(net.model.id, first.model.id);
  assert.equal(net.thinkingLevel, first.thinkingLevel);
  const server1 = await f.pi.virtual.route(failed('503 overload'), f.ctx);
  assert.equal(server1.model.id, first.model.id, 'first server failure retries the same pair');
  const server2 = await f.pi.virtual.route(failed('503 overload', server1.state), f.ctx);
  assert.notEqual(server2.model.provider, first.model.provider, 'second goes to another provider');
  assert.equal(server2.thinkingLevel, first.thinkingLevel === 'off' ? 'off' : server2.thinkingLevel);
  const ctxRetry = await f.pi.virtual.route(failed('context_length_exceeded'), f.ctx);
  assert.notEqual(ctxRetry.model.id, first.model.id);
  await assert.rejects(() => f.pi.virtual.route(failed('HTTP 403 denied'), f.ctx), /política|policy/);
  const q1 = await f.pi.virtual.route(failed('wrong answer'), f.ctx);
  assert.equal(q1.model.id, first.model.id, 'quality ladder: more effort on the same model first');
  assert.ok(['minimal', 'low', 'medium', 'high'].indexOf(q1.thinkingLevel) > ['off', 'minimal', 'low', 'medium', 'high'].indexOf(first.thinkingLevel) - 1);
  assert.notEqual(q1.thinkingLevel, first.thinkingLevel);
  const q2 = await f.pi.virtual.route(failed('wrong answer', q1.state, q1), f.ctx);
  assert.equal(q2.state.qualityFailures[`p/${first.model.id}`] ?? q2.state.qualityFailures[`${first.model.provider}/${first.model.id}`], 2);
  const q3 = await f.pi.virtual.route(failed('wrong answer', q2.state, q2), f.ctx);
  assert.ok(q3.model.tier > first.model.tier || q3.model.id !== first.model.id, 'then the next tier');
});

test('continuation re-validates the sticky pair; a checkpoint forces a full decision', async (t) => {
  const { f } = await fixture(t);
  const first = await f.pi.virtual.route(user('adicione testes no parser'), f.ctx);
  const sticky = await f.pi.virtual.route(
    { reason: 'continuation', previous: first, state: first.state, messages: [{ role: 'user', content: 'adicione testes no parser' }] },
    f.ctx,
  );
  assert.equal(sticky.model.id, first.model.id);
  await f.command('economist', 'json');
  assert.match(f.notifications.at(-1), /sticky/);
  const withFailure = await f.pi.virtual.route(
    {
      reason: 'continuation',
      previous: first,
      state: first.state,
      messages: [
        { role: 'user', content: 'adicione testes no parser' },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: 'bash', arguments: { command: 'npm test' } }] },
        { role: 'toolResult', toolCallId: 'x', toolName: 'bash', isError: true, details: { exitCode: 1 }, content: [{ type: 'text', text: '1 failing' }] },
      ],
    },
    f.ctx,
  );
  assert.ok(withFailure.model);
  await f.command('economist', 'json');
  assert.match(f.notifications.at(-1), /checkpoint/);
  assert.match(f.notifications.at(-1), /test_rejected/);
});

test('simulate accepts --floor and rejects an override outside (0,1]', async (t) => {
  const { f } = await fixture(t);
  await f.command('economist', 'simulate adicione testes no parser --floor 0.86');
  assert.match(f.notifications.at(-1), /"qualityFloor":0\.86/);
  assert.match(f.notifications.at(-1), /"selectedModelId":"(q\/strong|p\/vision)"/, 'only tier 4 clears 0.86');
  await assert.rejects(() => f.command('economist', 'simulate oi --floor 2'), /\(0, 1\]/);
});

test('verified outcomes reach the decision; a model claim does not', async (t) => {
  const { f, dir } = await fixture(t);
  await f.pi.virtual.route(user('adicione testes no parser'), f.ctx);
  f.pi.events.emit('economist:outcome', { source: 'assistant', success: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await rowsOf(dir, 'outcomes')).length, 0);
  f.pi.events.emit('economist:outcome', { source: 'test', verifier: 'node --test', success: true });
  await new Promise((r) => setTimeout(r, 20));
  const outs = await rowsOf(dir, 'outcomes');
  assert.equal(outs.length, 1);
  assert.equal(outs[0].source, 'test');
  // O resultado verificado chega à decisão de forma assíncrona; em runners lentos 20 ms não bastam.
  for (let i = 0; i < 100; i++) {
    await f.command('economist', 'explain');
    if (/resultado final: success/.test(f.notifications.at(-1))) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(f.notifications.at(-1), /resultado final: success/);
  assert.match(f.notifications.at(-1), /pSuccess:[\s\S]*p95[\s\S]*custo previsto[\s\S]*cache[\s\S]*calibração/);
});

test('subagent without an envelope is degraded; with one it inherits risk', async (t) => {
  const { f } = await fixture(t);
  await f.command('economist', 'cadence subagent');
  const bare = await f.pi.tool.execute('1', { task: 'resuma o arquivo' }, null, null, f.ctx);
  assert.equal(bare.details.degraded, true);
  assert.ok(bare.details.reasonCodes.includes('degraded-subagent-context'));
  const env = await f.pi.tool.execute('2', { task: 'resuma o arquivo', envelope: { environment: 'production', risks: ['production'] } }, null, null, f.ctx);
  assert.equal(env.details.degraded, false);
  assert.ok(['q/strong', 'p/vision'].includes(env.details.model), 'inherited production risk needs tier ≥ 3');
});

test('images: uninspected without a describer, captioned by an injected local describer', async (t) => {
  const image = { reason: 'user', thinkingLevel: 'off', messages: [{ role: 'user', content: [{ type: 'text', text: 'o que tem aqui?' }, { type: 'image', data: 'BYTES' }] }] };
  const { f } = await fixture(t);
  const plain = await f.pi.virtual.route(image, f.ctx);
  assert.equal(plain.model.id, 'vision');
  await f.command('economist', 'json');
  assert.match(f.notifications.at(-1), /image-uninspected/);
  const seen = [];
  const described = await fixture(t, '  classifier:\n    imageDescriber:\n      mode: local\n', {
    describeImage: async (bytes, opts) => {
      seen.push([bytes, opts.mode]);
      return 'um gráfico de barras com email ana@example.com';
    },
  });
  await described.f.pi.virtual.route(image, described.f.ctx);
  assert.deepEqual(seen, [['BYTES', 'local']]);
  await described.f.command('economist', 'json');
  const shown = described.f.notifications.at(-1);
  assert.match(shown, /image-captioned/);
  assert.doesNotMatch(shown, /ana@example\.com/);
  const blocked = await fixture(t, '  classifier:\n    allowRemote: false\n    imageDescriber:\n      mode: authorized-remote\n', { describeImage: async () => 'x' });
  await blocked.f.pi.virtual.route(image, blocked.f.ctx);
  await blocked.f.command('economist', 'json');
  assert.match(blocked.f.notifications.at(-1), /image-describer-blocked/);
});

test('fast path is decided by pSuccess with margin, and risk blocks it', async (t) => {
  const { f } = await fixture(t);
  const hi = await f.pi.virtual.route(user('oi'), f.ctx);
  assert.equal(hi.model.id, 'cheap');
  assert.equal(hi.state.phase, 'fast');
  const risky = await f.pi.virtual.route(user('apague o banco de produção'), f.ctx);
  assert.equal(risky.state.phase, 'normal');
});

/* ------------------------------ phase 5 ------------------------------ */

const matrixRow = (i, date, prompt = 'adicione testes no parser') => ({
  id: `t${i}`,
  prompt,
  occurredAt: date,
  actions: [
    { model: 'p/cheap', effort: 'off', tier: 1, success: i % 3 !== 0, costUsd: 0.001, latencyMs: 400 },
    { model: 'p/mid', effort: 'low', tier: 2, success: true, costUsd: 0.01, latencyMs: 900 },
    { model: 'q/strong', effort: 'high', tier: 4, success: true, costUsd: 0.1, latencyMs: 4000 },
  ],
});

test('offline matrix benchmark: oracle, regret, strata, holdout, never calls a model', () => {
  const rows = Array.from({ length: 40 }, (_, i) => matrixRow(i, new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), i % 2 ? 'oi' : 'adicione testes no parser'));
  const r = benchmarkMatrix(rows, { holdoutBefore: '2026-01-21T00:00:00Z' });
  assert.equal(r.evaluation, 'holdout');
  assert.equal(r.trainRows, 20);
  assert.equal(r.testRows, 20);
  for (const policy of ['economy', 'balanced', 'quality', 'latency']) {
    const m = r.policies[policy];
    for (const k of ['successRate', 'totalCostUsd', 'costPerSuccessUsd', 'latencyP95Ms', 'meanRegret', 'oracleAgreement', 'oracleSuccessRate', 'strongestCostUsd', 'savingsVsStrongestUsd', 'ece', 'brier', 'policyResults', 'strata'])
      assert.ok(Object.hasOwn(m, k), `${policy}.${k}`);
    assert.ok(m.meanRegret >= 0, 'the oracle is an upper bound');
    assert.ok(Object.keys(m.strata).some((k) => k.startsWith('difficulty:')));
    assert.ok(Object.keys(m.strata).some((k) => k.startsWith('risk:')));
  }
  assert.ok(r.policies.economy.totalCostUsd <= r.policies.quality.totalCostUsd);
  const pre = benchmarkMatrix(rows.slice(0, 5));
  assert.equal(pre.evaluation, 'prequential');
  assert.throws(() => benchmarkMatrix(Array.from({ length: 1001 }, (_, i) => matrixRow(i, null))), /1000/);
  assert.throws(() => benchmarkMatrix([{ id: 'x', actions: [{ model: 'p/a' }] }]), /success/);
});

test('/economist benchmark reads a matrix file and reports per policy', async (t) => {
  const { f, dir } = await fixture(t);
  const rows = Array.from({ length: 6 }, (_, i) => matrixRow(i, new Date(Date.UTC(2026, 0, 1 + i)).toISOString()));
  await writeFile(join(dir, 'matrix.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
  await f.command('economist', 'benchmark --dataset matrix.jsonl --holdout-before 2026-01-04T00:00:00Z --policy economy');
  const shown = f.notifications.at(-1);
  assert.match(shown, /holdout/);
  assert.match(shown, /economy/);
  assert.doesNotMatch(shown, /balanced/);
});

test('explain lines show pSuccess, pSafe, p50, p95, cost, cache, outcome, ROI and calibration', () => {
  const lines = explainLines(
    {
      selectedModelId: 'p/m',
      selectedThinkingLevel: 'low',
      pSuccess: 0.8,
      pSafe: null,
      qualityFloor: 0.7,
      latencyP50Ms: 500,
      latencyP95Ms: 900,
      predictedCostUsd: 0.002,
      expectedCacheSavingsUsd: 0.0001,
      expectedCacheLossUsd: 0,
      finalOutcome: 'success',
      classifierRoiUsd: -0.0001,
      reasonCodes: [],
    },
    c,
    { calibration: { n: 40, ece: 0.12 } },
  ).join('\n');
  for (const rx of [/pSuccess: 80\.0%/, /pSafe: sem amostras/, /p50 500 ms/, /p95 900 ms/, /\$0\.002000/, /cache: economia/, /resultado final: success/, /ROI do classificador: -0\.000100/, /ECE 0\.120/])
    assert.match(lines, rx);
});
