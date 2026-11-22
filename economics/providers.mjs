/** Versioned provider contracts. Prices always come from the selected host model. */
export const PROVIDER_CONTRACT_VERSION = '2026-11-18';
export const PROVIDER_SOURCES = {
  openai: 'https://developers.openai.com/api/docs/guides/prompt-caching',
  anthropic: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching',
};
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function providerContract(model = {}, request = {}) {
  const provider = String(model.provider ?? '').toLowerCase(), api = String(model.api ?? '');
  const explicit = model.cacheRetentionMs;
  const controls = [];
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (value.cache_control?.type === 'ephemeral') controls.push(value.cache_control.ttl ?? '5m');
    for (const key of ['system', 'messages', 'content', 'tools']) {
      const children = value[key];
      if (Array.isArray(children)) for (const child of children) walk(child);
    }
  };
  walk(request);
  const family = provider === 'anthropic' && /anthropic/.test(api) ? 'anthropic' : provider === 'openai' && /openai/.test(api) ? 'openai' : 'unknown';
  let retention = null, enabled = null;
  if (finite(explicit)) { retention = { minMs: explicit, typicalMs: explicit, maxMs: explicit, provenance: 'host', kind: 'fixed' }; enabled = true; }
  else if (family === 'anthropic' && controls.length) {
    const durations = controls.map(ttl => ttl === '1h' ? 3600000 : ttl === '5m' ? 300000 : null);
    if (durations.every(finite)) retention = { minMs: Math.min(...durations), typicalMs: Math.min(...durations), maxMs: Math.max(...durations), provenance: 'documented-request', kind: 'fixed' };
    enabled = true;
  } else if (family === 'openai') {
    const mode = request.prompt_cache_retention ?? model.promptCacheRetention;
    // In-memory eviction is not a guaranteed TTL. These are documented estimates.
    retention = mode === '24h' ? { minMs: 0, typicalMs: 86400000, maxMs: 86400000, provenance: 'documented-request', kind: 'eviction' }
      : { minMs: 0, typicalMs: 600000, maxMs: 3600000, provenance: 'documented-estimate', kind: 'eviction' };
    enabled = true;
  }
  return { family, version: PROVIDER_CONTRACT_VERSION, source: PROVIDER_SOURCES[family] ?? null, enabled, retention,
    minimumPrefixTokens: family === 'openai' ? 1024 : null,
    priceProvenance: 'host', crossModelReuse: false, writeAccounting: family === 'openai' ? 'included-in-input' : 'separate-or-unknown' };
}

export function retentionProbability(retention, ageMs) {
  if (!retention || !finite(ageMs)) return { value: null, interval: null, provenance: 'unknown' };
  if (ageMs > retention.maxMs) return { value: 0, interval: [0, 0], provenance: 'estimated' };
  if (retention.kind === 'fixed') return { value: ageMs <= retention.minMs ? 1 : 0,
    interval: retention.minMs === retention.maxMs ? [ageMs <= retention.minMs ? 1 : 0, ageMs <= retention.minMs ? 1 : 0] : [0, 1], provenance: 'estimated' };
  return { value: Math.exp(-ageMs / Math.max(1, retention.typicalMs)), interval: [0, 1], provenance: 'estimated' };
}
