import { known, effectiveInputCost, providerEconomics } from './cost.mjs';
import { tokens } from '../context/artifacts.mjs';
import { hash } from '../lib/core.mjs';
/** API accounting is separate from measured local latency; no hidden CPU-to-dollar conversion. */
export class OperationLedger {
  constructor(rows = []) { this.rows = rows.slice(-2000); }
  record(row) {
    if (!row.id || !['retrieval', 'compaction', 'handoff', 'rewarm', 'refetch', 'rework', 'classifier'].includes(row.category)) throw Error('Invalid economic operation');
    if (this.rows.some(r => r.id === row.id)) return false;
    this.rows.push({ ...row, usd: known(row.usd) ? row.usd : null }); return true;
  }
  totals({ routeId, sessionId, taskId } = {}) {
    const rows = this.rows.filter(r => (!routeId || r.routeId === routeId) && (!sessionId || r.sessionId === sessionId) && (!taskId || r.taskId === taskId));
    return Object.fromEntries(['retrieval', 'compaction', 'handoff', 'rewarm', 'refetch', 'rework', 'classifier'].map(category => {
      const group = rows.filter(r => r.category === category);
      return [category, group.every(r => known(r.usd)) ? group.reduce((n, r) => n + r.usd, 0) : null];
    }));
  }
}

/** Incremental token cost uses cache-read prices only when a hit prediction is known. */
export function tokenIncrement(model, count, cache = null) {
  if (!model || !known(count)) return null;
  const prices = providerEconomics(model).prices;
  const probability = cache?.probability;
  const cached = known(probability) && known(prices.cacheRead) ? count * Math.min(1, probability) : 0;
  return effectiveInputCost({ uncached: count - cached, cacheRead: cached, cacheWrite: 0 }, prices).usd;
}

export function contextEconomics({ model, ledger, scopeKey, inputTokens, checkpoint, prediction, recoveryCostUsd, horizon = 1, fidelity = null } = {}) {
  const summaryTokens = checkpoint ? tokens(JSON.stringify(checkpoint)) : null;
  const forecast = ledger && model && known(inputTokens) ? ledger.forecast(model, scopeKey, { inputTokens, outputTokens: 0 }) : null;
  const keepCostUsd = known(forecast?.usd) ? forecast.usd * Math.max(1, horizon) : null;
  const summaryInput = model && known(summaryTokens) ? tokenIncrement(model, summaryTokens) : null;
  const rewarmUsd = known(summaryInput) ? summaryInput : null;
  const compactCostUsd = known(summaryInput) ? summaryInput * Math.max(1, horizon) : null; // Deterministic local checkpoint: zero inference API charge.
  const failureCost = known(recoveryCostUsd) ? recoveryCostUsd : known(keepCostUsd) ? keepCostUsd : null;
  const informationLossUsd = known(fidelity) && known(failureCost) ? (1 - Math.min(1, fidelity)) * failureCost : null;
  return { keepCostUsd, compactCostUsd, informationLossUsd, rewarmUsd, summaryTokens,
    predictedFailure: known(prediction) ? 1 - Math.min(1, prediction) : null,
    failureCostUsd: failureCost, nextStepTokens: summaryTokens == null ? 2048 : Math.min(8192, summaryTokens), provenance: 'estimated',
    assumptions: ['chars-per-token', 'finite-planning-horizon', 'local-checkpoint-no-inference'], fingerprint: hash({ inputTokens, summaryTokens, horizon }) };
}

export function contextValue({ prediction, failureCostUsd, tokenCostUsd, relevance, calibratedGain = null } = {}) {
  if (![prediction, failureCostUsd, tokenCostUsd, relevance].every(known)) return { successGain: null, failureCost: failureCostUsd ?? null, retrieveCost: 0, tokenCost: tokenCostUsd ?? null, provenance: 'unknown' };
  // A forecast derived from the same routing posterior; it is never reported as measured quality.
  const gain = known(calibratedGain) ? calibratedGain : (1 - Math.min(1, prediction)) * Math.min(1, relevance);
  return { successGain: Math.max(0, Math.min(1 - prediction, gain)), failureCost: failureCostUsd, retrieveCost: 0, tokenCost: tokenCostUsd,
    provenance: 'estimated', source: known(calibratedGain) ? 'verified-context-posterior' : 'routing-posterior-and-relevance' };
}

export function remainingBudgets(config, calls = [], operations = [], scope = {}) {
  const money = row => row.observedCostUsd ?? row.estimatedCostUsd ?? row.actualCost?.value ?? row.cost?.value ?? row.usd;
  const callIds = new Set(calls.map(c => c.id));
  const all = [...calls, ...operations.filter(r => {
    if (r.callId && callIds.has(r.callId)) return false;
    // Explicit budget attribution also covers host operations absent from the shared journal.
    return r.budgetIncludedInCalls != null || r.includedInCalls !== true;
  })];
  const limits = [
    ['task', config.budgetUsd, r => scope.taskId ? r.taskId === scope.taskId : r.sessionId === scope.sessionId],
    ['session', config.sessionBudgetUsd, r => r.sessionId === scope.sessionId], ['project', config.projectBudgetUsd, () => true],
  ].filter(([, value]) => Number.isFinite(value));
  const rows = limits.map(([name, limit, filter]) => {
    const entries = all.filter(filter), unknown = entries.some(row => !known(money(row)));
    return { scope: name, limitUsd: limit, spentUsd: unknown ? null : entries.reduce((n, row) => n + money(row), 0),
      remainingUsd: unknown ? null : limit - entries.reduce((n, row) => n + money(row), 0), unknown };
  });
  return { remainingUsd: rows.some(r => r.unknown) ? null : rows.length ? Math.min(...rows.map(r => r.remainingUsd)) : Infinity, scopes: rows };
}
