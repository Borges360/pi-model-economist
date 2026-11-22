import { timed, uid } from '../lib/core.mjs';
import { privateText } from '../context/artifacts.mjs';
const strings = (values, field) => {
  if (!Array.isArray(values) || values.length > 128 || values.some(v => typeof v !== 'string' || v.length > 16000)) throw Error(`Invalid delegation ${field}`);
  return values.map(privateText);
};
const safeFile = p => typeof p === 'string' && p.length > 0 && !/^(?:[A-Za-z]:|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)|(?:^|[\\/])(?:\.env(?:\..*)?|\.git|\.ssh)(?:[\\/]|$)/i.test(p);
export function delegationContract(raw = {}) {
  if (typeof raw.objective !== 'string' || !raw.objective.trim() || raw.objective.length > 16000) throw Error('Delegation objective required');
  const allowedFiles = strings(raw.allowedFiles ?? [], 'allowedFiles');
  if (!allowedFiles.every(safeFile)) throw Error('Delegation files must be relative project paths');
  const permissions = strings(raw.permissions ?? ['read'], 'permissions');
  if (!permissions.every(p => ['read', 'test', 'write'].includes(p))) throw Error('Unsupported delegation permission');
  const contextRefs = strings(raw.contextRefs ?? [], 'contextRefs');
  if (!contextRefs.every(h => /^econ:[a-f0-9]{64}$/.test(h))) throw Error('Invalid delegation context reference');
  const budget = raw.budget ?? {};
  if (!['usd', 'tokens', 'turns'].every(k => typeof budget[k] === 'number' && Number.isFinite(budget[k]) && budget[k] > 0)) throw Error('Finite delegation budgets required');
  return { objective: privateText(raw.objective), acceptanceCriteria: strings(raw.acceptanceCriteria ?? [], 'acceptanceCriteria'),
    constraints: strings(raw.constraints ?? [], 'constraints'), allowedFiles, contextRefs, budget: { usd: budget.usd, tokens: budget.tokens, turns: budget.turns }, permissions };
}
export function topologyPlan({ mechanicality = 0, separability = 0, verifiability = 0, ambiguity = 1, contextCoupling = 1, hardRisk = false }, { threshold = 0.45, enabled = false, available = false } = {}) {
  const values = [mechanicality, separability, verifiability, ambiguity, contextCoupling];
  if (!values.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) throw Error('Invalid topology features');
  const score = mechanicality * separability * verifiability - ambiguity - contextCoupling;
  return { topology: enabled && available && !hardRisk && score > threshold ? 'isolated-worker' : 'single-agent', score,
    reason: hardRisk ? 'hard-risk' : !available ? 'isolated-adapter-unavailable' : score > threshold ? 'separable-verifiable-work' : 'context-coupling' };
}
export class SubagentCoordinator {
  constructor(adapter, config = {}) { this.adapter = adapter; this.config = config; this.active = new Map(); }
  get available() { return this.adapter?.available !== false && typeof this.adapter?.execute === 'function' && this.adapter.isolatedContext === true && this.adapter.enforcesBudgets === true && this.adapter.enforcesPermissions === true; }
  async execute(raw, { signal, route = null, onEvent = async () => {} } = {}) {
    if (!this.available) throw Error('Isolated worker adapter with budget and permission enforcement is unavailable');
    if (this.active.size >= (this.config.maxWorkers ?? 1)) throw Error('Worker concurrency limit reached');
    const contract = delegationContract(raw);
    if (contract.budget.usd > (this.config.budgetUsd ?? 0.1) || contract.budget.tokens > (this.config.budgetTokens ?? 4096) || contract.budget.turns > (this.config.maxTurns ?? 4)) throw Error('Delegation exceeds configured budget');
    const id = uid(), controller = new AbortController(); this.active.set(id, controller);
    try {
      await onEvent('delegate.started', { count: this.active.size });
      const result = await timed(s => this.adapter.execute(contract, { signal: s,
        ...(route ? { model: route.model, thinkingLevel: route.thinkingLevel, local: route.local === true } : {}) }), this.config.timeoutMs ?? 60000,
        signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
      if (!['done', 'blocked', 'needs-review'].includes(result?.status)) throw Error('Invalid worker result');
      const changedFiles = strings(result.changedFiles ?? [], 'changedFiles');
      if (!changedFiles.every(p => safeFile(p) && contract.allowedFiles.includes(p)) || changedFiles.length && !contract.permissions.includes('write')) throw Error('Worker changed files outside contract');
      const measured = result.measuredCost;
      if (!measured || !['usd', 'tokens', 'turns'].every(k => typeof measured[k] === 'number' && Number.isFinite(measured[k]) && measured[k] >= 0 && measured[k] <= contract.budget[k])) throw Error('Worker usage missing or exceeds budget');
      const handoff = { status: result.status, summary: privateText(result.summary ?? ''), changedFiles,
        tests: (result.tests ?? []).map(t => ({ name: privateText(t.name ?? ''), passed: t.passed === true, verified: t.verified === true })),
        artifacts: strings(result.artifacts ?? [], 'artifacts').filter(h => /^econ:[a-f0-9]{64}$/.test(h)),
        unresolved: strings(result.unresolved ?? [], 'unresolved'), measuredCost: { usd: measured.usd, tokens: measured.tokens, turns: measured.turns,
          provenance: ['derived', 'observed'].includes(measured.provenance) ? measured.provenance : 'unknown' },
        workerSessionId: typeof result.workerSessionId === 'string' ? result.workerSessionId.slice(0, 200) : null,
        calls: Array.isArray(result.calls) ? result.calls.slice(0, 100).map(call => ({ model: typeof call.model === 'string' ? call.model.slice(0, 200) : null,
          usd: Number.isFinite(call.usd) && call.usd >= 0 ? call.usd : null, provenance: ['derived', 'observed'].includes(call.provenance) ? call.provenance : 'unknown',
          usage: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(k => [k, Number.isFinite(call.usage?.[k]) && call.usage[k] >= 0 ? call.usage[k] : null])) })) : [], reviewRequired: true };
      await onEvent('delegate.completed', { status: handoff.status, costUsd: measured.usd }); return handoff;
    } catch (error) {
      await onEvent('delegate.completed', { status: 'blocked', costUsd: null, reason: 'execution-or-observation-failed' });
      throw error;
    } finally { controller.abort(); this.active.delete(id); }
  }
  async dispose() {
    for (const controller of this.active.values()) controller.abort(Error('session ended'));
    if (this.adapter?.dispose) await timed(signal => this.adapter.dispose({ signal }), Math.min(this.config.timeoutMs ?? 5000, 5000));
  }
}
