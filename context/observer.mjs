import { measure, callCost, known, providerEconomics } from '../economics/cost.mjs';
import { normalizeCacheUsage } from '../economics/cache.mjs';
import { quantile, calibrationReport } from '../decision.mjs';
export class EconomicsObserver {
  constructor() { this.calls = []; this.routes = []; this.context = { tokens: null, window: null, provenance: 'unknown' }; this.outputs = []; this.retrievals = []; this.compactions = []; this.delegations = []; }
  observeOutput(output) {
    // Context hooks replay the transcript. One tool result is one observation,
    // even when a later request retains a different preview of that result.
    const index = this.outputs.findIndex(row => row.id === output.id);
    if (index < 0) this.outputs.push(output);
    else this.outputs[index] = output;
  }
  contextUsage(usage) {
    this.context = { tokens: known(usage?.tokens) ? usage.tokens : null, window: known(usage?.contextWindow) ? usage.contextWindow : null,
      provenance: known(usage?.tokens) ? 'estimated' : 'unknown', source: 'host' };
  }
  observeCall(message, model, { scopeKey, durationMs = null, ttftMs = null, routeId = null, prediction = null } = {}) {
    const usage = message.usage ?? {};
    const cache = normalizeCacheUsage(usage, { provider: message.provider, model: `${message.provider}/${message.model}`, scopeKey });
    const cost = callCost(usage, model);
    const adapter = providerEconomics(model);
    const savings = known(cache.cacheReadTokens) && known(adapter.prices.input) && known(adapter.prices.cacheRead)
      ? cache.cacheReadTokens * (adapter.prices.input - adapter.prices.cacheRead) / 1e6 : null;
    const call = { id: `${message.provider}/${message.responseId ?? `${message.model}/${message.timestamp}`}`, routeId,
      ...cache, cost: cost.cost, actualCost: cost.actualCost, cacheSavingsUsd: measure(savings, 'derived', 'observed-reads-times-price'),
      durationMs, ttftMs, prediction, postCompaction: this.compactions.length > 0, predictedCostUsd: null };
    if (!this.calls.some(c => c.id === call.id)) this.calls.push(call);
    return call;
  }
  report(outcomes = []) {
    const total = getter => this.calls.length && this.calls.every(c => known(getter(c))) ? this.calls.reduce((n, c) => n + getter(c), 0) : null;
    const operations = this.operations ?? [], external = operations.filter(r => r.includedInCalls !== true);
    const extra = external.every(r => known(r.usd)) ? external.reduce((n, r) => n + r.usd, 0) : null;
    const estimatedCalls = this.calls.length ? total(c => c.cost.value) : 0;
    const actualCalls = total(c => c.actualCost.value);
    const actualExtras = external.every(r => known(r.usd) && (r.usd === 0 || r.provenance === 'observed')) ? extra : null;
    const actualCostUsd = actualCalls != null && actualExtras != null ? actualCalls + actualExtras : null;
    const estimatedCostUsd = (this.calls.length || operations.length) && estimatedCalls != null && extra != null ? estimatedCalls + extra : null;
    const input = total(c => c.inputTokens), reads = total(c => c.cacheReadTokens), writes = total(c => c.cacheWriteTokens);
    const cacheObserved = this.calls.filter(c => known(c.cacheReadTokens));
    const routeIds = new Set([...this.calls, ...operations].map(c => c.routeId).filter(Boolean));
    const latest = new Map(outcomes.filter(o => routeIds.has(o.decisionId)).map(o => [o.taskId ?? o.decisionId ?? o.id, o]));
    const successes = [...latest.values()].filter(o => o.success === true).length;
    const injected = this.retrievals.reduce((n, r) => n + r.tokens, 0);
    const usageKnown = this.retrievals.length > 0 && this.retrievals.every(r => known(r.utilizedTokens));
    const yieldRatio = injected && usageKnown ? this.retrievals.reduce((n, r) => n + r.utilizedTokens, 0) / injected : null;
    const verifiedCalls = this.calls.map(c => ({ ...c, outcome: outcomes.findLast(o => o.decisionId === c.routeId) })).filter(c => c.outcome);
    const predictions = verifiedCalls.filter(c => known(c.prediction)).map(c => ({ p: c.prediction, success: c.outcome.success }));
    const calibration = calibrationReport(predictions);
    const postCompaction = verifiedCalls.filter(c => c.postCompaction);
    const costErrors = this.calls.map(c => c.actualCost.value == null || c.cost.value == null ? null
      : c.actualCost.value === 0 ? c.cost.value === 0 ? 0 : null : Math.abs(c.cost.value - c.actualCost.value) / c.actualCost.value * 100);
    const percentiles = values => ({ p50: quantile(values.filter(known), 0.5), p95: quantile(values.filter(known), 0.95) });
    return { actualCostUsd: measure(actualCostUsd, 'observed', 'provider'), estimatedCostUsd: measure(estimatedCostUsd, 'derived', 'host-usage'),
      costErrorPct: costErrors.length && costErrors.every(known) ? costErrors.reduce((n, v) => n + v, 0) / costErrors.length : null,
      verifiedSuccesses: successes, cpvs: successes && (actualCostUsd ?? estimatedCostUsd) != null ? (actualCostUsd ?? estimatedCostUsd) / successes : null,
      cpvsProvenance: actualCostUsd != null ? 'observed' : estimatedCostUsd != null ? 'derived' : 'unknown',
      context: this.context, cacheReadTokens: reads, cacheWriteTokens: writes, uncachedInputTokens: total(c => c.uncachedInputTokens),
      cacheHitRate: cacheObserved.length ? cacheObserved.filter(c => c.cacheReadTokens > 0).length / cacheObserved.length : null,
      cacheHitSamples: cacheObserved.length, cacheUnknownSamples: this.calls.length - cacheObserved.length,
      cachedTokenFraction: input > 0 && reads != null ? reads / input : null,
      cacheSavingsUsd: measure(total(c => c.cacheSavingsUsd.value), 'derived', 'observed-reads-times-price'),
      retainedTokens: this.outputs.reduce((n, o) => n + o.retainedTokens, 0), externalizedTokens: this.outputs.reduce((n, o) => n + o.externalizedTokens, 0),
      retrievedTokens: injected, contextYield: yieldRatio, pollution: yieldRatio == null ? null : 1 - yieldRatio,
      retrievalPrecision: this.retrievalQuality?.precision ?? null, retrievalRecall: this.retrievalQuality?.recall ?? null,
      compactions: this.compactions.length, compactionFidelity: this.compactions.at(-1)?.fidelity ?? null,
      compactionRatio: this.compactions.at(-1)?.ratio ?? null, postCompactionFailureRate: postCompaction.length ? postCompaction.filter(c => c.outcome.success === false).length / postCompaction.length : null,
      brier: predictions.length ? predictions.reduce((n, c) => n + (c.p - Number(c.success)) ** 2, 0) / predictions.length : null,
      ece: calibration.ece, fallbackRate: this.routes.length ? this.routes.filter(r => r.fallback).length / this.routes.length : null,
      qualityFloorViolations: this.routes.length ? this.routes.filter(r => r.qualityViolation).length : null,
      safetyFloorViolations: this.routes.length ? this.routes.filter(r => r.safetyViolation).length : null,
      latencyMs: percentiles(this.calls.map(c => c.durationMs)), ttftMs: percentiles(this.calls.map(c => c.ttftMs)),
      delegations: this.delegations.length,
      delegationSuccess: this.delegations.length && this.delegations.every(d => typeof d.verifiedSuccess === 'boolean')
        ? this.delegations.filter(d => d.verifiedSuccess).length / this.delegations.length : null,
      delegationReworkCost: operations.some(r => r.category === 'rework' && r.workerSessionId)
        ? operations.filter(r => r.category === 'rework' && r.workerSessionId).reduce((n, r) => r.usd == null || n === null ? null : n + r.usd, 0)
        : this.delegations.length && this.delegations.every(d => d.verifiedSuccess === true) ? 0 : null,
      operations: Object.fromEntries(['retrieval', 'compaction', 'handoff', 'rewarm', 'refetch', 'rework', 'classifier'].map(category => {
        const rows = operations.filter(r => r.category === category);
        return [category, { count: rows.length, apiUsd: rows.every(r => known(r.usd)) ? rows.reduce((n, r) => n + r.usd, 0) : null,
          attributedInputUsd: rows.length && rows.every(r => known(r.attributedInputUsd)) ? rows.reduce((n, r) => n + r.attributedInputUsd, 0) : null,
          localDurationMs: rows.reduce((n, r) => n + (r.durationMs ?? 0), 0) }];
      })) };
  }
}

/** Registering a hook does not prove support; event capabilities become observed on delivery. */
export class HostCapabilitiesProbe {
  constructor(pi, ctx, worker = null) {
    this.capabilities = Object.fromEntries(['context', 'context_with_system', 'before_provider_request', 'provider_stream_event', 'session_before_compact',
      'agent_before_settle', 'cache_warming_decision'].map(k => [k, 'unknown']));
    this.capabilities.contextUsage = typeof ctx.getContextUsage === 'function' ? 'available' : 'unavailable';
    this.capabilities.compact = typeof ctx.compact === 'function' ? 'available' : 'unavailable';
    this.capabilities.tools = typeof pi.registerTool === 'function' ? 'available' : 'unavailable';
    this.capabilities.isolatedWorker = worker?.available ? 'available' : 'unavailable';
  }
  observed(name) { this.capabilities[name] = 'observed'; }
  unavailable(name) { this.capabilities[name] = 'unavailable'; }
}
