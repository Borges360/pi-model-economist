import { providerContract } from './providers.mjs';
export const known = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export const measure = (value, provenance = 'unknown', source = null) => ({ value: known(value) ? value : null, provenance: known(value) ? provenance : 'unknown', source });
const sum = values => values.every(known) ? values.reduce((a, b) => a + b, 0) : null;

/** Input is decomposed exactly once. Pi input excludes read/write; OpenAI input includes cached. */
export function effectiveInputCost({ uncached = null, cacheRead = null, cacheWrite = null }, prices = {}) {
  const term = (tokens, rate) => tokens === 0 ? 0 : known(tokens) && known(rate) ? tokens * rate / 1e6 : null;
  const parts = { uncached: term(uncached, prices.input), cacheRead: term(cacheRead, prices.cacheRead), cacheWrite: term(cacheWrite, prices.cacheWrite) };
  return { usd: sum(Object.values(parts)), parts };
}

export function effectiveCost({ input, outputTokens = null, reasoningTokens = 0, prices = {}, classifier = 0, retrieval = 0,
  compaction = 0, handoff = 0, rewarm = 0, recovery = 0, rework = 0 } = {}) {
  const billedInput = effectiveInputCost(input ?? {}, prices);
  const output = known(outputTokens) && known(prices.output) ? outputTokens * prices.output / 1e6 : outputTokens === 0 ? 0 : null;
  const reasoning = reasoningTokens === 0 ? 0 : known(reasoningTokens) && known(prices.reasoning ?? prices.output)
    ? reasoningTokens * (prices.reasoning ?? prices.output) / 1e6 : null;
  const breakdown = { input: billedInput.usd, output, reasoning, classifier, retrieval, compaction, handoff, rewarm, recovery, rework };
  return { usd: sum(Object.values(breakdown)), breakdown, inputBreakdown: billedInput.parts };
}

export function providerEconomics(model = {}) {
  const p = model.cost ?? {};
  const number = v => known(v) ? v : null;
  const free = model.local === true;
  const unusable = !free && p.input === 0 && p.output === 0;
  return {
    adapterVersion: 2, provider: model.provider ?? null, contract: model.cacheEconomics ?? providerContract(model, model.cacheRequest),
    prices: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].map(k =>
      [k, unusable ? null : number(p[k] ?? (k === 'cacheRead' ? p.cachedInput : undefined))])),
    retentionMs: number(model.cacheRetentionMs), ttlClass: typeof model.cacheTtlClass === 'string' ? model.cacheTtlClass : null,
    priceProvenance: 'host',
  };
}

export function callCost(usage, model) {
  const prices = providerEconomics(model).prices;
  const num = v => known(v) ? v : null;
  const input = { uncached: num(usage?.input), cacheRead: num(usage?.cacheRead), cacheWrite: num(usage?.cacheWrite) };
  const calculated = effectiveCost({ input, outputTokens: num(usage?.output), prices });
  const hostCost = num(usage?.cost?.total);
  // Pi calculates usage.cost from metadata; it is not a provider invoice.
  return { cost: measure(hostCost ?? calculated.usd, 'derived', hostCost != null ? 'host-price-calculation' : 'usage-times-price'),
    actualCost: measure(usage?.billedCostUsd, 'observed', 'provider'), breakdown: calculated.breakdown };
}
