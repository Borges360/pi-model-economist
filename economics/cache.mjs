import { hash } from '../lib/core.mjs';
import { known, providerEconomics, effectiveCost } from './cost.mjs';
import { providerContract, retentionProbability } from './providers.mjs';

export function structuralKey({ provider, model, systemVersion, toolsManifestHash, cwdPolicyHash, contextGeneration = 0 }) {
  return hash({ provider, model, systemVersion, toolsManifestHash, cwdPolicyHash, contextGeneration });
}
export function toolsHash(tools = []) {
  const normalized = tools.map(t => typeof t === 'string' ? { name: t } : {
    type: t.type, name: t.name ?? t.function?.name, description: t.description ?? t.function?.description,
    parameters: t.parameters ?? t.input_schema ?? t.function?.parameters,
  });
  return hash(normalized.sort((a, b) => String(a.name).localeCompare(String(b.name))));
}
export function normalizeCacheUsage(usage = {}, { provider, model, source = 'host', scopeKey = null, observedAt = new Date().toISOString(), format = 'pi' } = {}) {
  const num = v => known(v) ? v : null;
  let read, write, uncached, total;
  if (format === 'openai') {
    total = num(usage.input_tokens ?? usage.prompt_tokens);
    read = num(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens);
    write = num(usage.cache_creation_input_tokens);
    uncached = total != null && read != null && (write === null || write === 0) ? Math.max(0, total - read) : null;
  } else if (format === 'anthropic') {
    uncached = num(usage.input_tokens); read = num(usage.cache_read_input_tokens); write = num(usage.cache_creation_input_tokens);
    total = [uncached, read, write].every(known) ? uncached + read + write : null;
  } else {
    uncached = num(usage.input); read = num(usage.cacheRead); write = num(usage.cacheWrite);
    total = [uncached, read, write].every(known) ? uncached + read + write : null;
  }
  return { provider, model, scopeKey, inputTokens: total, uncachedInputTokens: uncached, cacheReadTokens: read, cacheWriteTokens: write,
    hitRatio: total > 0 && read != null ? read / total : null, ttlClass: null, observedAt, source,
    provenance: total != null ? 'derived' : 'unknown', format };
}

export class CacheLedger {
  constructor(rows = []) { this.rows = rows.slice(-1000); this.invalidations = 0; this.contracts = new Map(); }
  configure(model, request) { const contract = providerContract(model, request); this.contracts.set(`${model.provider}/${model.id}`, contract); return contract; }
  observe(row) { this.rows.push(row); if (this.rows.length > 1000) this.rows.shift(); return row; }
  invalidate() { this.invalidations++; }
  predict(model, scopeKey, now = Date.now()) {
    const adapter = providerEconomics(model), id = `${model.provider}/${model.id}`;
    const matching = this.rows.filter(r => r.model === id && r.scopeKey === scopeKey && known(r.cacheReadTokens));
    const last = matching.at(-1);
    const contract = this.contracts.get(id) ?? last?.cacheContract ?? adapter.contract;
    const retention = contract.retention;
    if (!last || !retention) return { probability: null, reusableTokens: null, confidence: 'unknown', reason: !last ? 'no-prefix-evidence' : 'retention-unknown', terms: { prefixMatch: last ? 1 : null, withinTtl: null, providerAffinity: null } };
    const age = now - Date.parse(last.observedAt);
    if (!Number.isFinite(age) || age < 0) return { probability: null, reusableTokens: null, confidence: 'unknown', reason: 'timestamp-unknown' };
    const withinTtl = retentionProbability(retention, age), hits = matching.filter(r => r.cacheReadTokens > 0), n = matching.length;
    const affinity = hits.length / n, z = 1.96, denom = 1 + z * z / n;
    const center = (affinity + z * z / (2 * n)) / denom;
    const radius = z * Math.sqrt(affinity * (1 - affinity) / n + z * z / (4 * n * n)) / denom;
    return { probability: withinTtl.value == null ? null : affinity * withinTtl.value,
      interval: withinTtl.interval?.[0] === 0 && withinTtl.interval?.[1] === 1 ? [0, Math.min(1, center + radius)] : [Math.max(0, center - radius) * withinTtl.value, Math.min(1, center + radius) * withinTtl.value],
      terms: { prefixMatch: { value: 1, provenance: 'derived', confidence: 'high' }, withinTtl,
        providerAffinity: { value: affinity, provenance: 'derived', interval: [Math.max(0, center - radius), Math.min(1, center + radius)] } },
      reusableTokens: hits.length ? hits.reduce((s, r) => s + r.cacheReadTokens, 0) / hits.length : 0,
      confidence: n >= 30 && retention.kind === 'fixed' ? 'high' : 'low', provenance: 'estimated',
      reason: withinTtl.value === 0 ? 'retention-expired' : 'empirical-prefix', samples: n, contractVersion: contract.version };
  }
  forecast(model, scopeKey, { inputTokens, outputTokens, reasoningTokens = 0, useCache = true } = {}) {
    const prediction = useCache ? this.predict(model, scopeKey) : { probability: null, reusableTokens: null, confidence: 'unknown', reason: 'cache-disabled' };
    const prices = providerEconomics(model).prices;
    // Cold-cost fallback is explicit, not an assertion that unknown hit probability is zero.
    const cached = prediction.probability == null || !known(prices.cacheRead) ? 0 : Math.min(inputTokens, prediction.reusableTokens ?? 0) * prediction.probability;
    return { ...effectiveCost({ input: { uncached: inputTokens - cached, cacheRead: cached, cacheWrite: 0 }, outputTokens, reasoningTokens, prices }),
      prediction, cachedTokens: cached, provenance: 'estimated', coldFallback: prediction.probability == null };
  }
}
