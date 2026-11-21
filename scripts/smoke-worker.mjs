import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { piCore } from './pi-module.mjs';
import { PiWorker } from '../topology/pi-worker.mjs';
import { ArtifactStore } from '../context/artifacts.mjs';
import { TestStream } from '../test-support/fakes.mjs';

const { Agent } = await piCore(), root = await mkdtemp(join(tmpdir(), 'econ-worker-host-'));
const model = { provider: 'synthetic', id: 'worker', api: 'openai-completions', name: 'offline fixture', input: ['text'],
  contextWindow: 32000, maxTokens: 512, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } };
let turn = 0, lastContext, caps = [];
const registry = { find: () => model, hasConfiguredAuth: () => true,
  streamSimple: (_model, context, options) => {
    lastContext = context; caps.push(options.maxTokens); turn++;
    const stream = new TestStream(), message = { role: 'assistant', provider: model.provider, model: model.id, api: model.api,
      timestamp: Date.now(), stopReason: 'stop', content: [{ type: 'text', text: 'Offline worker handoff.' }],
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0.0001, output: 0.00002, cacheRead: 0, cacheWrite: 0, total: 0.00012 } } };
    if (turn === 1) { message.stopReason = 'toolUse'; message.content = [{ type: 'toolCall', id: 'write', name: 'worker_write', arguments: { path: 'allowed.json', content: '{"ok":true}' } }]; }
    if (turn === 2) { message.stopReason = 'toolUse'; message.content = [{ type: 'toolCall', id: 'check', name: 'worker_test', arguments: { path: 'allowed.json', kind: 'json' } }]; }
    stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); return stream;
  } };
const adapter = new PiWorker({ Agent, context: () => ({ modelRegistry: registry }), root, artifacts: new ArtifactStore(join(root, '.context')), maxWorkers: 2 });
try {
  await writeFile(join(root, 'allowed.json'), '{"old":"long value that must be truncated"}');
  await writeFile(join(root, 'outside.json'), 'private');
  const contract = { objective: 'Update JSON and run parser tests', acceptanceCriteria: ['valid JSON'], constraints: [], allowedFiles: ['allowed.json'], contextRefs: [],
    permissions: ['read', 'write', 'test'], budget: { usd: 1, tokens: 20000, turns: 4 } };
  const result = await adapter.execute(contract, { model: 'synthetic/worker', thinkingLevel: 'off' });
  assert.equal(result.measuredCost.turns, 3); assert.equal(result.tests[0].passed, true);
  assert.equal(await readFile(join(root, 'allowed.json'), 'utf8'), '{"ok":true}');
  assert.ok(!JSON.stringify(lastContext).includes('private')); assert.ok(caps.every(n => n > 0 && n <= 512));
  const before = turn;
  await assert.rejects(adapter.execute({ ...contract, budget: { usd: 0.000000001, tokens: 1, turns: 1 } }, { model: 'synthetic/worker' }), /budget|fit/);
  assert.equal(turn, before, 'over-budget request is blocked before provider invocation');
  const repeat = await adapter.execute(contract, { model: 'synthetic/worker' });
  assert.equal(result.workerSessionId, repeat.workerSessionId, 'worker context/cache identity persists independently');
  const deniedContract = { ...contract, objective: 'Read-only worker', permissions: ['read'] };
  const readOnly = await adapter.execute(deniedContract, { model: 'synthetic/worker' });
  assert.ok(readOnly.workerSessionId !== result.workerSessionId);
  assert.ok(!JSON.stringify(lastContext.tools ?? lastContext.messages?.[0]).includes('worker_write'));
  const changedConstraints = await adapter.execute({ ...deniedContract, constraints: ['New invariant'] }, { model: 'synthetic/worker' });
  assert.notEqual(changedConstraints.workerSessionId, readOnly.workerSessionId, 'changed invariants cannot reuse an older worker transcript');
  let notifyStarted; const started = new Promise(resolve => { notifyStarted = resolve; });
  registry.streamSimple = (_model, _context, options) => {
    const stream = new TestStream();
    options.signal.addEventListener('abort', () => {
      const message = { role: 'assistant', provider: model.provider, model: model.id, api: model.api,
        stopReason: 'aborted', content: [], timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
      stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(message);
    }, { once: true });
    notifyStarted(); return stream;
  };
  const controller = new AbortController();
  const cancelled = adapter.execute({ ...deniedContract, objective: 'Cancellation smoke' }, { model: 'synthetic/worker', signal: controller.signal });
  await started; controller.abort(Error('Smoke cancellation'));
  await assert.rejects(cancelled, /cancel|abort/i);
  assert.ok([...adapter.workers.values()].every(slot => !slot.busy), 'cancellation waits until the real Agent is idle');
  console.log('PASS real Pi Agent: separate persistent contexts/cache ids, bounded requests, allowlisted write/read/JSON verifier, cancellation/idle cleanup, no provider network calls.');
} finally {
  await adapter.dispose();
  const absolute = await realpath(root), base = await realpath(tmpdir()), rel = relative(base, absolute);
  if (!rel || rel.startsWith('..') || !rel.startsWith('econ-worker-host-')) throw Error('Unsafe smoke cleanup target');
  await rm(absolute, { recursive: true, force: true });
}
