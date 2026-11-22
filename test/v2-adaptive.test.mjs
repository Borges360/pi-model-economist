import test from 'node:test';
import assert from 'node:assert/strict';
import { switchDecision, contextualBandit, costCascade, rolloutAllowed, rollbackReasons } from '../routing/adaptive.mjs';
import { evaluateAblations, offPolicy, verifiedMetrics, ARMS } from '../learning/calibration.mjs';
import { delegationContract, topologyPlan, SubagentCoordinator } from '../topology/delegate.mjs';
import { defaults } from '../routing.mjs';
import { presetPatch, migrateConfig, validateV2 } from '../lib/v2-config.mjs';

const action = (id, cost, p = 0.9) => ({ id: `${id}#off`, modelId: id, effort: 'off', policyCostUsd: cost, baseCostUsd: cost, pSuccess: p, pSafe: null, qualityFloor: 0.8 });
test('hysteresis avoids marginal switches and cooldown but never retains an infeasible or unsafe action', () => {
  const current = action('p/current', 0.1), marginal = action('p/new', 0.095), cheap = action('p/cheap', 0.05);
  assert.equal(switchDecision([current, marginal], marginal, { currentId: current.id }).selected.id, current.id);
  assert.equal(switchDecision([current, cheap], cheap, { currentId: current.id, turnsSinceSwitch: 0 }).selected.id, current.id);
  assert.equal(switchDecision([cheap], cheap, { currentId: current.id }).selected.id, cheap.id);
  assert.equal(switchDecision([current, cheap], cheap, { currentId: current.id, hardRisk: true }).selected.id, cheap.id);
  assert.equal(switchDecision([current, cheap], cheap, { currentId: current.id, turnsSinceSwitch: 5 }).selected.id, cheap.id);
  assert.equal(costCascade([action('bad', 0.001, 0.5), current, cheap], { floor: 0.8 }).id, cheap.id);
});
test('bandit stays shadow until family samples exist, with floors and hard-risk prohibition', () => {
  const greedy = action('p/a', 0.1), other = action('p/b', 0.09);
  assert.equal(contextualBandit([greedy, other], greedy, [], { family: 'f' }).eligible, false);
  assert.equal(contextualBandit([other], greedy, [], { hardRisk: true }).choice.id, greedy.id);
  const outcomes = Array.from({ length: 40 }, () => ({ verified: true, family: 'f', model: 'p/b', effort: 'off', success: true }));
  assert.equal(contextualBandit([greedy, other], greedy, outcomes, { family: 'f' }).eligible, true);
  assert.equal(contextualBandit([greedy, other], greedy, outcomes.map(o => ({ ...o, verified: false })), { family: 'f' }).eligible, false);
  assert.equal(contextualBandit([greedy, action('unsafe', 0, 0.1)], greedy, outcomes, { family: 'f' }).choice.id, greedy.id);
});
test('rollout has deterministic canaries and automatic rollback on safety/fidelity/regression', () => {
  assert.equal(rolloutAllowed('observe', 'x'), false); assert.equal(rolloutAllowed('shadow', 'x'), false);
  assert.equal(rolloutAllowed('active', 'x', { approved: false }), false);
  assert.equal(rolloutAllowed('active', 'x', { rollback: true }), false);
  const selected = Array.from({ length: 1000 }, (_, i) => rolloutAllowed('canary-5', String(i))).filter(Boolean).length;
  assert.ok(selected > 20 && selected < 90);
  assert.equal(rolloutAllowed('canary-25', 'key'), rolloutAllowed('canary-25', 'key'));
  assert.ok(rollbackReasons({ safetyEvents: 1 }, null).length);
  assert.ok(rollbackReasons({ compactionFidelity: 0.8 }, null).includes('compaction-fidelity'));
  assert.ok(rollbackReasons({ n: 40, cpvs: 2, successRate: 0.8, ece: 0.2 }, { n: 40, cpvs: 1, successRate: 0.9, ece: 0.02 }).includes('cost-regression'));
});
export function matrix(n = 35) {
  return Array.from({ length: n }, (_, i) => ARMS.map(arm => ({ taskId: `t${i}`, seed: i, arm, model: 'same', version: 'v1', provider: 'p', commit: 'abc', toolsHash: 'h', timeoutMs: 10000, verifier: 'test',
    verified: true, success: true, provenance: 'measured', costUsd: arm === 'v0.4' ? 0.1 : 0.07, prediction: 0.98, latencyMs: 100, qualityFloorSatisfied: true, safetyFloorSatisfied: true,
    actualCostUsd: arm === 'v0.4' ? 0.1 : 0.07, estimatedCostUsd: arm === 'v0.4' ? 0.1 : 0.07,
    inputTokens: 10000, uncachedInputTokens: arm === 'v0.4' ? 10000 : 6000, cacheReadTokens: 0, cacheWriteTokens: 0, bulkOutput: true,
    constraintRecall: 1, compactionFidelity: 1, postCompaction: true, retrievedCount: 10, relevantRetrievedCount: 8, requiredRelevantCount: 10,
    switchCacheMisses: arm === 'v0.4' ? 2 : 1, modelSwitches: 2, reworkTurns: 0, ttftMs: 10,
    strata: { task: i % 2 ? 'read' : 'edit', cache: i % 3 ? 'warm' : 'cold' } }))).flat();
}
test('six-arm paired ablations use measured CPVS, reproducible bootstrap and reject unmatched controls', () => {
  const rows = matrix(), a = evaluateAblations(rows, { resamples: 100 }), b = evaluateAblations(rows, { resamples: 100 });
  assert.deepEqual(a, b); assert.equal(a.arms['full-adaptive'].eligible, true);
  assert.ok(a.arms.context.probabilityImprovement > 0.95); assert.equal(a.arms.context.pairedN, 35);
  assert.equal(evaluateAblations(rows.map(r => r.arm === 'context' ? { ...r, commit: 'other' } : r), { resamples: 100 }).arms.context.pairedN, 0);
  assert.equal(evaluateAblations(rows.map(r => r.arm === 'full-adaptive' ? { ...r, costUsd: null } : r), { resamples: 100 }).arms['full-adaptive'].eligible, false);
  assert.throws(() => evaluateAblations([{ arm: 'context' }]), /controls/);
  assert.equal(verifiedMetrics([{ success: true, verified: true, costUsd: null }]).cpvs, null);
});
test('off-policy evaluation reports overlap limitations and never invents unchosen outcomes', () => {
  const report = offPolicy([{ success: true, verified: true, propensity: 0.5 }, { success: false, verified: true, propensity: 0.5 },
    { success: true, verified: true, propensity: null }], () => 0.5);
  assert.equal(report.snips, 0.5); assert.equal(report.effectiveSampleSize, 2); assert.equal(report.unsupported, 1);
  assert.equal(offPolicy([], () => 1).snips, null);
});

test('acceptance rejects selectively missing latency, calibration and failed pair measurements', () => {
  for (const field of ['latencyMs', 'prediction']) {
    const rows = matrix();
    delete rows.find(r => r.arm === 'full-adaptive')[field];
    const report = evaluateAblations(rows, { resamples: 100 }).arms['full-adaptive'];
    assert.equal(report.eligible, false);
    assert.equal(report.acceptance[field === 'latencyMs' ? 'latency' : 'calibration'], false);
  }
  const rows = matrix();
  const missing = rows.find(r => r.arm === 'full-adaptive');
  missing.success = false; missing.costUsd = null;
  const report = evaluateAblations(rows, { resamples: 100 }).arms['full-adaptive'];
  assert.equal(report.pairedN, 34); assert.equal(report.excludedPairs, 1);
  assert.equal(report.acceptance.completePairs, false); assert.equal(report.eligible, false);
});

test('acceptance names unmatched controls and cannot lower the minimum independent task count', () => {
  const rows = matrix(); rows.find(r => r.arm === 'full-adaptive').commit = 'mismatched';
  const report = evaluateAblations(rows, { resamples: 100 }).arms['full-adaptive'];
  assert.equal(report.unmatchedBaseline, 1); assert.equal(report.unmatchedTreatment, 1);
  assert.equal(report.acceptance.completePairs, false); assert.equal(report.eligible, false);
  const small = evaluateAblations(matrix(1), { resamples: 100, minSamples: 1 });
  assert.equal(small.minSamples, 30); assert.equal(small.arms['full-adaptive'].eligible, false);
  const partial = evaluateAblations(matrix().filter(r => ['v0.4', 'full-adaptive'].includes(r.arm)), { resamples: 100 });
  assert.equal(partial.arms['full-adaptive'].acceptance.ablationCoverage, false);
  assert.equal(partial.arms['full-adaptive'].eligible, false);
});

test('ablation schema rejects invalid probabilities, retrieval counts and experimental controls', () => {
  for (const patch of [{ prediction: 1.1 }, { compactionFidelity: -0.1 }, { relevantRetrievedCount: 11 },
    { latencyMs: '100' }, { timeoutMs: 0 }, { provider: {} }]) {
    const rows = matrix(1); Object.assign(rows[0], patch);
    assert.throws(() => evaluateAblations(rows, { resamples: 100 }), /Invalid ablation matrix|experimental controls/);
  }
  assert.throws(() => evaluateAblations([null]), /experimental controls/);
});
test('presets preserve safety and never lower configured floors; migration preserves legacy policy', () => {
  for (const preset of ['economy', 'balanced', 'quality', 'adaptive']) {
    const patch = presetPatch(preset, defaults.modelEconomist);
    assert.equal(patch.objectives.safetyThreshold, undefined);
    for (const [key, value] of Object.entries(defaults.modelEconomist.objectives.qualityFloor)) assert.ok(patch.objectives.qualityFloor[key] >= value);
  }
  assert.equal(migrateConfig({ policy: 'latency' }).policy, 'latency'); assert.equal(migrateConfig({ policy: 'latency' }).preset, 'custom');
  assert.throws(() => validateV2({ context: { compaction: { minFidelity: 0.1 } } }), /minFidelity/);
  assert.throws(() => validateV2({ topology: { maxWorkers: 0 } }), /maxWorkers/);
});
const contract = () => ({ objective: 'Inspect parser tests', acceptanceCriteria: ['report verifier result'], constraints: ['no network'], allowedFiles: ['parser.mjs'], contextRefs: [],
  budget: { usd: 0.1, tokens: 1000, turns: 2 }, permissions: ['read', 'test'] });
test('topology uses mechanicality/separability/verifiability and blocks hard-risk/unsupported execution', async () => {
  assert.equal(topologyPlan({ mechanicality: 1, separability: 1, verifiability: 1, ambiguity: 0, contextCoupling: 0 }, { enabled: true, available: true }).topology, 'isolated-worker');
  assert.equal(topologyPlan({ mechanicality: 1, separability: 1, verifiability: 1, ambiguity: 0, contextCoupling: 0, hardRisk: true }, { enabled: true, available: true }).topology, 'single-agent');
  assert.throws(() => delegationContract({ ...contract(), allowedFiles: ['../secret'] }), /relative/);
  assert.throws(() => delegationContract({ ...contract(), permissions: ['admin'] }), /permission/);
  await assert.rejects(new SubagentCoordinator().execute(contract()), /unavailable/);
});
test('isolated worker receives only the contract and enforces handoff/usage/file boundaries', async () => {
  let received;
  const adapter = { isolatedContext: true, enforcesBudgets: true, enforcesPermissions: true, async execute(c) { received = c;
    return { status: 'done', summary: 'tests passed', tests: [{ name: 'parser', passed: true, verified: true }], changedFiles: [], measuredCost: { usd: 0.02, tokens: 100, turns: 1 } }; } };
  const coordinator = new SubagentCoordinator(adapter);
  const result = await coordinator.execute({ ...contract(), transcript: 'must never reach worker' });
  assert.equal(received.transcript, undefined); assert.equal(result.reviewRequired, true); assert.equal(result.measuredCost.usd, 0.02);
  adapter.execute = async () => ({ status: 'done', changedFiles: ['other.mjs'], measuredCost: { usd: 0, tokens: 0, turns: 0 } });
  await assert.rejects(coordinator.execute(contract()), /outside contract/);
  adapter.execute = async () => ({ status: 'done', changedFiles: [], measuredCost: { usd: 100, tokens: 0, turns: 0 } });
  await assert.rejects(coordinator.execute(contract()), /usage/);
});
test('worker cancellation reaches the adapter and disposes session resources', async () => {
  let aborted = false;
  const adapter = { isolatedContext: true, enforcesBudgets: true, enforcesPermissions: true, execute: (_c, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true })) };
  const coordinator = new SubagentCoordinator(adapter, { timeoutMs: 1000 });
  const pending = coordinator.execute(contract());
  await new Promise(resolve => setImmediate(resolve));
  await coordinator.dispose(); await assert.rejects(pending); assert.equal(aborted, true);
});
