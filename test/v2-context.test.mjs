import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore, artifactPreview, tokens } from '../context/artifacts.mjs';
import { retrieve, retrievalVoi } from '../context/retrieval.mjs';
import { structuredCheckpoint, checkpointFidelity, prepareStructuredCompaction, compactionPolicy } from '../context/compaction.mjs';
import { planContext } from '../context/planner.mjs';
import { ContextEconomics } from '../context/runtime.mjs';
import { FileStore } from '../lib/core.mjs';
import { defaults } from '../routing.mjs';
import { fakePi } from '../test-support/fakes.mjs';
import { ACCEPTANCE_GATE_VERSION } from '../learning/calibration.mjs';

async function store(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'econ-v2-context-')); t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, artifacts: new ArtifactStore(join(dir, 'artifacts'), options) };
}
test('externalized tool output remains recoverable in bounded slices, redacts secrets and rejects traversal', async t => {
  const { artifacts } = await store(t);
  const content = Array.from({ length: 500 }, (_, n) => `file ${n}: parser symbol failed at line ${n}`).join('\n');
  const ref = await artifacts.put(content); assert.ok(ref);
  const preview = artifactPreview(ref, content);
  assert.ok(tokens(preview) < tokens(content) * 0.8);
  const a = await artifacts.get(ref.handle, { budgetTokens: 40 });
  const b = await artifacts.get(ref.handle, { offset: a.nextOffset, budgetTokens: 40 });
  assert.equal(a.text + b.text, content.slice(0, 320));
  await assert.rejects(artifacts.get('econ:../.env'), /Invalid/);
  await assert.rejects(artifacts.get(ref.handle, { budgetTokens: 100000 }), /range/);
  const secret = await artifacts.put('token=synthetic-sensitive-value');
  assert.ok(!(await artifacts.get(secret.handle)).text.includes('synthetic-sensitive-value'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(artifacts.get(ref.handle, { signal: controller.signal }));
});
test('store bounds, retention and tamper checks preserve the original rather than creating incomplete handles', async t => {
  const { artifacts } = await store(t, { maxArtifactBytes: 1024, maxStoreBytes: 2000, retentionDays: 1 });
  assert.equal(await artifacts.put('many words '.repeat(1000)), null);
  const ref = await artifacts.put('a short artifact');
  await writeFile(join(artifacts.root, `${ref.handle.slice(5)}.txt`), 'tampered');
  await assert.rejects(artifacts.get(ref.handle), /integrity/);
  await artifacts.prune(Date.now() + 2 * 86400000); assert.equal((await artifacts.list()).length, 0);
});
test('lexical/symbol retrieval respects budget and abstains on irrelevant material or unknown VOI', async t => {
  const { artifacts } = await store(t);
  const ref = await artifacts.put('function parseWidget() { return parserWidget; }\n' + 'widget parser implementation\n'.repeat(100), { symbols: ['parseWidget'] });
  await artifacts.put('unrelated artwork and scenery');
  const result = await retrieve(artifacts, 'parseWidget parser', { budgetTokens: 128 });
  assert.equal(result.items[0].handle, ref.handle); assert.ok(result.tokens <= 128);
  assert.equal((await retrieve(artifacts, 'unseenReferenceName')).items.length, 0);
  assert.equal((await retrieve(artifacts, 'parser', { economics: {} })).reason, 'voi-unknown');
  assert.equal(retrievalVoi({ successGain: 0.2, failureCost: 1, retrieveCost: 0.01, tokenCost: 0.01 }).retrieve, true);
  assert.equal(retrievalVoi({ successGain: 0.01, failureCost: 1, retrieveCost: 0.1, tokenCost: 0.01 }).retrieve, false);
});
test('file indexing is project confined, excludes protected files and collects symbols', async t => {
  const { dir, artifacts } = await store(t);
  await writeFile(join(dir, 'parser.mjs'), 'export function parseWidget() { return 1; }');
  const ref = await artifacts.indexFile(dir, 'parser.mjs'); assert.deepEqual(ref.symbols, ['parseWidget']);
  await writeFile(join(dir, '.env'), 'SYNTHETIC=private');
  await assert.rejects(artifacts.indexFile(dir, '.env'), /Protected/);
  await assert.rejects(artifacts.indexFile(dir, '../outside.txt'));
  await mkdir(join(dir, 'linked'));
  // Junction creation does not require Windows developer-mode privileges.
  await symlink(join(dir, 'linked'), join(dir, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(dir, 'linked', 'file.mjs'), 'test');
  await assert.rejects(artifacts.indexFile(dir, 'junction/file.mjs'), /link|outside|escape/i);
});
test('three compactions preserve human invariants, rationale, file changes, tests and recovery handles', () => {
  const initial = structuredCheckpoint([
    { role: 'user', content: 'Never publish. Preserve all acceptance criteria. Constraint α.' },
    { role: 'assistant', content: 'Decision: preserve parser order\nRationale: deterministic cache prefix\nNext: run tests' },
    { role: 'toolResult', details: { command: 'npm test', exitCode: 0 }, content: [] },
  ], { fileOps: { edited: new Set(['src/parser.mjs']), read: new Set(['README.md']) }, handles: ['econ:' + 'a'.repeat(64)] });
  let current = initial;
  for (let round = 0; round < 3; round++) current = structuredCheckpoint([{ role: 'user', content: `Additional constraint ${round}` }], { previous: JSON.stringify(current) });
  const fidelity = checkpointFidelity(initial, current);
  assert.equal(fidelity.constraints, 1); assert.equal(fidelity.fidelity, 1);
  assert.deepEqual(current.tests.passed, ['npm test']); assert.ok(current.changed_files.includes('src/parser.mjs'));
  assert.ok(current.decisions.some(d => d.statement.includes('Rationale')));
  const damaged = structuredClone(current); damaged.constraints = [];
  assert.ok(checkpointFidelity(initial, damaged).fidelity < 0.95);
});
test('compaction preserves the host cut point and falls back if invariants cannot fit or evidence is not recoverable', () => {
  const prep = { firstKeptEntryId: 'cut', tokensBefore: 10000, messagesToSummarize: [{ role: 'user', content: 'Keep constraints' }], fileOps: {} };
  const result = prepareStructuredCompaction(prep);
  assert.equal(result.compaction.firstKeptEntryId, 'cut'); assert.equal(result.compaction.tokensBefore, 10000);
  assert.equal(prepareStructuredCompaction({ ...prep, messagesToSummarize: [{ role: 'assistant', content: 'critical evidence' }] }).compaction, null);
  assert.equal(prepareStructuredCompaction(prep, { maxCheckpointTokens: 1 }).compaction, null);
  const policy = compactionPolicy({ contextTokens: 9800, contextWindow: 10000, turnsSinceCompact: 5, nextStepTokens: 1000 });
  assert.equal(policy.compact, true);
  assert.equal(compactionPolicy({ contextTokens: 5000, contextWindow: 10000 }).compact, false);
  const plan = planContext({ context: { tokens: null, window: 10000 } }, {});
  assert.equal(plan.compact.compact, false); assert.equal(plan.topology.topology, 'single-agent');
});

test('committed checkpoint evidence survives expiry while capacity remains bounded', async t => {
  const { artifacts } = await store(t, { retentionDays: 1 });
  const pinned = await artifacts.put('checkpoint recovery evidence'), expired = await artifacts.put('ephemeral exploration');
  await artifacts.pin([pinned.handle]); await artifacts.prune(Date.now() + 2 * 86400000);
  assert.equal((await artifacts.get(pinned.handle)).text, 'checkpoint recovery evidence');
  await assert.rejects(artifacts.get(expired.handle));
});
test('facts needed at turns 5, 10 and 20 survive three structured compactions without hallucinated invariants', () => {
  const initial = structuredCheckpoint([{ role: 'user', content: 'Acceptance: preserve Unicode; never publish; verify parser tests.' },
    { role: 'assistant', content: 'Decision: preserve order\nRationale: cache stability' }], { handles: ['econ:' + 'b'.repeat(64)] });
  let checkpoint = initial;
  for (let turn = 1; turn <= 20; turn++) {
    if ([4, 9, 14].includes(turn)) checkpoint = structuredCheckpoint([{ role: 'assistant', content: `Exploration turn ${turn}` }], { previous: checkpoint });
    if ([5, 10, 20].includes(turn)) {
      const score = checkpointFidelity(initial, checkpoint);
      assert.equal(score.constraints, 1); assert.equal(score.decisions, 1); assert.equal(score.artifacts, 1); assert.equal(score.hallucinationRate, 0);
    }
  }
});
test('automatic rollback is persisted across fresh sessions and clears only with new eligible evidence', async t => {
  const { dir } = await store(t), f = fakePi(dir);
  const rt = { store: new FileStore(join(dir, 'state')), root: dir, ctx: f.ctx, config: structuredClone(defaults) };
  const first = new ContextEconomics(f.pi, rt); await first.init(f.ctx);
  first.observer.compactions.push({ fidelity: 0.8, ratio: 0.5 }); await first.checkRollback([]);
  assert.ok(first.rollback.includes('compaction-fidelity')); await first.dispose();
  f.ctx.sessionManager.getSessionId = () => 'second-session';
  const second = new ContextEconomics(f.pi, rt); await second.init(f.ctx);
  assert.ok(second.rollback.includes('compaction-fidelity'));
  await second.acceptNewEvidence({ arms: { 'full-adaptive': { eligible: false } } }); assert.ok(second.rollback);
  await second.acceptNewEvidence({ arms: { 'full-adaptive': { eligible: true } } }); assert.ok(second.rollback);
  const report = { gateVersion: ACCEPTANCE_GATE_VERSION, arms: { 'full-adaptive': { eligible: true } } };
  await rt.store.append('economics-evaluations', { id: 'test-only-proof', policyFingerprint: second.evidenceFingerprint(), report });
  await second.acceptNewEvidence(report); assert.equal(second.rollback, null);
  await second.dispose();
});
test('verifier-reported floor violations trigger rollback even when the predicted route met its floors', async t => {
  const { dir } = await store(t), f = fakePi(dir);
  const rt = { store: new FileStore(join(dir, 'state')), root: dir, ctx: f.ctx, config: structuredClone(defaults) };
  const engine = new ContextEconomics(f.pi, rt); await engine.init(f.ctx);
  engine.observer.calls.push({ routeId: 'route', prediction: 0.99, cost: { value: 0.01 }, actualCost: { value: null }, cacheSavingsUsd: { value: null } });
  engine.observer.routes.push({ id: 'route', qualityViolation: false, safetyViolation: false });
  await engine.checkRollback([{ decisionId: 'route', verified: true, success: false, qualityFloorViolation: true }]);
  assert.ok(engine.rollback.includes('floor-or-safety-event')); await engine.dispose();
});
test('activation proof is invalidated by changes to privacy, topology, routing and budgets', async t => {
  const { dir } = await store(t), f = fakePi(dir);
  const rt = { store: new FileStore(join(dir, 'state')), root: dir, ctx: f.ctx, config: structuredClone(defaults) };
  const engine = new ContextEconomics(f.pi, rt); await engine.init(f.ctx);
  const original = structuredClone(rt.config.modelEconomist), fingerprint = engine.evidenceFingerprint();
  await rt.store.append('economics-evaluations', { id: 'test-only-proof', policyFingerprint: fingerprint,
    report: { gateVersion: ACCEPTANCE_GATE_VERSION, arms: { 'full-adaptive': { eligible: true } } } });
  assert.equal((await engine.proof()).eligible, true);
  await rt.store.append('economics-evaluations', { id: 'old-proof', policyFingerprint: fingerprint,
    report: { gateVersion: ACCEPTANCE_GATE_VERSION - 1, arms: { 'full-adaptive': { eligible: true } } } });
  assert.equal(await engine.proof(), null);
  await rt.store.append('economics-evaluations', { id: 'new-proof', policyFingerprint: fingerprint,
    report: { gateVersion: ACCEPTANCE_GATE_VERSION, arms: { 'full-adaptive': { eligible: true } } } });
  for (const change of [c => { c.classifier.dataPolicy = 'deny'; }, c => { c.topology.budgetUsd += 0.1; },
    c => { c.routing.switch.minExpectedGainPct += 1; }, c => { c.sessionBudgetUsd = 1; }]) {
    rt.config.modelEconomist = structuredClone(original); change(rt.config.modelEconomist);
    assert.notEqual(engine.evidenceFingerprint(), fingerprint); assert.equal(await engine.proof(), null);
  }
  await engine.dispose();
});
test('late worker accounting stays with its original project/session after a context switch', async t => {
  const { dir } = await store(t), f = fakePi(dir);
  const original = new FileStore(join(dir, 'old-state'));
  const rt = { store: original, root: dir, ctx: f.ctx, config: structuredClone(defaults) };
  const engine = new ContextEconomics(f.pi, rt); await engine.init(f.ctx);
  const owner = engine.captureOwner(f.ctx);
  rt.store = new FileStore(join(dir, 'new-state')); rt.root = join(dir, 'other-project');
  f.ctx.sessionManager.getSessionId = () => 'new-session'; await engine.init(f.ctx);
  await engine.operation('handoff', { usd: null, provenance: 'unknown', includedInCalls: false }, owner);
  assert.equal((await original.rows('economic-operations'))[0].sessionId, 'S1');
  assert.equal((await rt.store.rows('economic-operations')).length, 0);
  assert.equal(engine.observer.operations.length, 0); await engine.dispose();
});
