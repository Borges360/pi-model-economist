/** Presets never lower existing quality floors or change the safety threshold. */
export const PRESETS = ['economy', 'balanced', 'quality', 'adaptive', 'custom'];
export const CONTROLS = ['automatic', 'ask', 'advisory'];
export const STAGES = ['observe', 'shadow', 'canary-5', 'canary-25', 'active'];
export const v2Defaults = {
  configVersion: 2, preset: 'balanced', control: 'advisory',
  context: {
    enabled: true, externalizeAboveTokens: 2048, previewTokens: 128,
    maxArtifactBytes: 2_000_000, maxStoreBytes: 32_000_000, retentionDays: 7,
    retrieval: { enabled: true, budgetTokens: 2048, minScore: 0.12, epsilon: 0.1, embeddings: false },
    compaction: { enabled: true, threshold: 0.72, minFidelity: 0.95, minTurns: 3, maxCheckpointTokens: 8192 },
  },
  cache: { enabled: true },
  routing: { switch: { minExpectedGainPct: 12, minTurnsBetweenSwitches: 2, riskPremiumUsd: 0, uncertaintyPremiumUsd: 0 } },
  topology: { enabled: true, threshold: 0.45, timeoutMs: 60_000, maxWorkers: 1, budgetUsd: 0.1, budgetTokens: 4096, maxTurns: 4 },
  adaptive: { algorithm: 'expected-cost', bandit: 'shadow', minSamples: 30, kappa: 0.15 },
  rollout: { stage: 'observe', maxQualityRegression: 0.01, maxCostRegression: 0.15, maxEceRegression: 0.01 },
};

export function migrateConfig(section = {}) {
  if (section.configVersion === 2 || section.version === 2) return normalizeOptimizer(section);
  // Map the preset without reapplying it: preserve every independent legacy value.
  return { ...normalizeOptimizer(section), configVersion: 2,
    preset: ['economy', 'balanced', 'quality'].includes(section.policy) ? section.policy : 'custom', control: section.control ?? 'advisory',
    topology: { ...section.topology, enabled: section.topology?.enabled ?? false },
    migration: { fromVersion: '0.4', warnings: ['Legacy aliases are retained for this release; /economist migrate --preview shows the canonical mapping.'] } };
}

export function normalizeOptimizer(section = {}) {
  const next = structuredClone(section), optimizer = section.optimizer ?? {};
  const assign = (key, patch) => { next[key] = { ...(next[key] ?? {}), ...patch }; };
  if (section.version === 2) next.configVersion = 2;
  const routing = optimizer.routing;
  if (typeof routing === 'string') assign('routing', { enabled: routing !== 'off' });
  if (routing && typeof routing === 'object') {
    if (routing.cadence != null) next.cadence = routing.cadence;
    if (routing.algorithm != null) assign('adaptive', { algorithm: routing.algorithm });
    if (routing.switch) assign('routing', { switch: routing.switch });
  }
  const context = optimizer.context;
  if (typeof context === 'string') assign('context', { enabled: context !== 'off' });
  else if (context && typeof context === 'object') {
    const retrieval = context.retrieval ?? {};
    assign('context', { ...(context.discovery != null ? { enabled: context.discovery !== 'off' } : {}),
      ...(context.retrieval ? { retrieval: { ...next.context?.retrieval, ...retrieval,
        ...(retrieval.tokenBudget != null ? { budgetTokens: retrieval.tokenBudget } : {}),
        ...(retrieval.embeddings != null ? { embeddings: retrieval.embeddings === 'auto' ? true : retrieval.embeddings } : {}) } } : {}),
      ...(context.compaction ? { compaction: { ...next.context?.compaction, ...context.compaction,
        ...(context.compaction.strategy != null ? { enabled: context.compaction.strategy !== 'off' } : {}) } } : {}) });
  }
  if (optimizer.cache != null && (typeof optimizer.cache === 'string' || optimizer.cache.mode != null)) assign('cache', { enabled: optimizer.cache !== 'off' && optimizer.cache?.mode !== 'off' });
  if (optimizer.delegation != null) assign('topology', {
    ...(typeof optimizer.delegation === 'string' || optimizer.delegation.mode != null ? { enabled: optimizer.delegation !== 'off' && optimizer.delegation?.mode !== 'off' } : {}),
    ...(typeof optimizer.delegation === 'object' ? optimizer.delegation : {}) });
  if (optimizer.learning?.deployment) assign('adaptive', { bandit: optimizer.learning.deployment });
  if (section.classifier?.mode) next.mode = section.classifier.mode;
  if (section.roles) assign('rolePreferences', section.roles);
  if (section.budget && typeof section.budget === 'object') {
    if (section.budget.task != null) next.budgetUsd = section.budget.task;
    if (section.budget.session != null) next.sessionBudgetUsd = section.budget.session;
    if (section.budget.project != null) next.projectBudgetUsd = section.budget.project;
  }
  for (const destination of ['classifier', 'executor', 'telemetry']) {
    const privacy = section.privacy?.[destination] ?? section.dataPolicy?.[destination] ?? (typeof section.dataPolicy === 'string' ? section.dataPolicy : null);
    if (privacy != null) assign(destination, { dataPolicy: typeof privacy === 'string' ? privacy : privacy.dataPolicy });
  }
  return next;
}

export function migrationPreview(section = {}) {
  const effective = migrateConfig(section);
  const after = { ...effective, version: 2, configVersion: 2, optimizer: {
    ...effective.optimizer,
    routing: { ...effective.optimizer?.routing, algorithm: effective.adaptive?.algorithm ?? 'expected-cost', cadence: effective.cadence ?? 'prompt', switch: effective.routing?.switch },
    context: { ...effective.optimizer?.context, discovery: effective.context?.enabled === false ? 'off' : 'hybrid',
      retrieval: { ...effective.context?.retrieval, tokenBudget: effective.context?.retrieval?.budgetTokens ?? 2048 },
      compaction: { ...effective.context?.compaction, strategy: effective.context?.compaction?.enabled === false ? 'off' : 'adaptive', checkpointing: 'incremental' } },
    cache: { mode: effective.cache?.enabled === false ? 'off' : 'measured-first', unknownPricing: 'exclude-from-savings' },
    delegation: { mode: effective.topology?.enabled ? 'verified' : 'off', maxWorkers: effective.topology?.maxWorkers ?? 1, requireVerifier: true },
    learning: { deployment: effective.adaptive?.bandit ?? 'shadow' },
  } };
  const changes = [];
  const visit = (before, value, path = '') => {
    for (const [key, v] of Object.entries(value)) {
      const p = path ? `${path}.${key}` : key;
      if (v && typeof v === 'object' && !Array.isArray(v)) visit(before?.[key], v, p);
      else if (JSON.stringify(before?.[key]) !== JSON.stringify(v)) changes.push({ path: p, before: before?.[key] ?? null, after: v });
    }
  };
  visit(section, after);
  return { preview: true, writes: false, changes, config: after, warnings: effective.migration?.warnings ?? [] };
}

export function synchronizeAliases(existing = {}, patch = {}) {
  const result = structuredClone(patch);
  if (existing.optimizer) {
    result.optimizer = { ...patch.optimizer };
    const routing = { ...(typeof existing.optimizer.routing === 'object' ? existing.optimizer.routing : {}), ...patch.optimizer?.routing };
    if (patch.cadence != null) routing.cadence = patch.cadence;
    if (patch.adaptive?.algorithm != null) routing.algorithm = patch.adaptive.algorithm;
    if (patch.routing?.switch) routing.switch = { ...routing.switch, ...patch.routing.switch };
    if (patch.cadence != null || patch.adaptive?.algorithm != null || patch.routing?.switch) result.optimizer.routing = routing;
    if (patch.context) result.optimizer.context = { ...(typeof existing.optimizer.context === 'object' ? existing.optimizer.context : {}),
      ...patch.optimizer?.context, ...(patch.context.enabled != null ? { discovery: patch.context.enabled ? 'hybrid' : 'off' } : {}),
      ...(patch.context.retrieval ? { retrieval: { ...existing.optimizer.context?.retrieval, ...patch.context.retrieval,
        ...(patch.context.retrieval.budgetTokens != null ? { tokenBudget: patch.context.retrieval.budgetTokens } : {}) } } : {}),
      ...(patch.context.compaction ? { compaction: { ...existing.optimizer.context?.compaction, ...patch.context.compaction,
        ...(patch.context.compaction.enabled != null ? { strategy: patch.context.compaction.enabled ? 'adaptive' : 'off' } : {}) } } : {}) };
    if (patch.cache?.enabled != null) result.optimizer.cache = { ...existing.optimizer.cache, mode: patch.cache.enabled ? 'measured-first' : 'off' };
    if (patch.topology) result.optimizer.delegation = { ...existing.optimizer.delegation, ...patch.topology,
      ...(patch.topology.enabled != null ? { mode: patch.topology.enabled ? 'verified' : 'off' } : {}) };
    if (patch.adaptive?.bandit) result.optimizer.learning = { ...existing.optimizer.learning, deployment: patch.adaptive.bandit };
  }
  if (existing.classifier?.mode != null && patch.mode != null) result.classifier = { ...result.classifier, mode: patch.mode };
  if (existing.roles && patch.rolePreferences) result.roles = { ...existing.roles, ...patch.rolePreferences };
  for (const key of ['classifier', 'executor', 'telemetry']) if ((existing.privacy || existing.dataPolicy) && patch[key]?.dataPolicy != null)
    result.privacy = { ...existing.privacy, ...result.privacy, [key]: patch[key].dataPolicy };
  if (existing.budget) for (const [key, alias] of [['budgetUsd', 'task'], ['sessionBudgetUsd', 'session'], ['projectBudgetUsd', 'project']])
    if (patch[key] != null) result.budget = { ...existing.budget, ...result.budget, [alias]: patch[key] };
  return result;
}

export function presetPatch(preset, current = {}) {
  if (!PRESETS.includes(preset)) throw Error('Invalid economist preset');
  if (preset === 'custom') return { configVersion: 2, preset };
  const qualityFloor = Object.fromEntries(Object.entries(current.objectives?.qualityFloor ?? {}).map(([key, value]) =>
    [key, Math.max(value, preset === 'quality' ? 0.85 : value)]));
  return {
    configVersion: 2, preset, policy: preset === 'adaptive' ? 'balanced' : preset,
    ...(preset === 'adaptive' ? { rollout: { stage: 'shadow' } } : current.control && current.control !== 'advisory' && current.rollout?.stage === 'observe'
      ? { rollout: { stage: 'active' } } : {}),
    cadence: 'prompt', thinking: { mode: 'auto' },
    objectives: { qualityFloor },
    context: { enabled: true,
      retrieval: { enabled: true, budgetTokens: preset === 'quality' ? 4096 : 2048 },
      compaction: { enabled: true, threshold: preset === 'economy' ? 0.62 : preset === 'quality' ? 0.86 : 0.72 } },
    adaptive: { algorithm: 'expected-cost', bandit: preset === 'quality' ? 'off' : 'shadow' },
    topology: { enabled: true, threshold: preset === 'quality' ? 0.7 : preset === 'economy' ? 0.35 : 0.45 },
    learned: { deployment: 'shadow' },
  };
}

export function validateV2(m) {
  const object = (v, key) => { if (v != null && (typeof v !== 'object' || Array.isArray(v))) throw Error(`Invalid economist ${key}`); };
  const enumeration = (v, values, key) => { if (v != null && !values.includes(v)) throw Error(`Invalid economist ${key}`); };
  const range = (v, min, max, key) => { if (v != null && (!Number.isFinite(v) || v < min || v > max)) throw Error(`Invalid economist ${key}`); };
  enumeration(m.configVersion, [2], 'configVersion');
  enumeration(m.preset, PRESETS, 'preset'); enumeration(m.control, CONTROLS, 'control');
  for (const key of ['context', 'cache', 'routing', 'topology', 'adaptive', 'rollout']) object(m[key], key);
  for (const key of ['retrieval', 'compaction']) object(m.context?.[key], `context.${key}`);
  object(m.routing?.switch, 'routing.switch');
  enumeration(m.topology?.consent, ['ask', 'always'], 'topology.consent');
  for (const key of ['budgetUsd', 'sessionBudgetUsd', 'projectBudgetUsd']) range(m[key], 0, 1000000, key);
  enumeration(m.rollout?.stage, STAGES, 'rollout.stage');
  enumeration(m.adaptive?.algorithm, ['expected-cost', 'cascade', 'bandit'], 'adaptive.algorithm');
  enumeration(m.adaptive?.bandit, ['off', 'shadow', 'active'], 'adaptive.bandit');
  for (const [key, v] of Object.entries({ context: m.context?.enabled, cache: m.cache?.enabled, topology: m.topology?.enabled,
    routing: m.routing?.enabled,
    retrieval: m.context?.retrieval?.enabled, compaction: m.context?.compaction?.enabled, embeddings: m.context?.retrieval?.embeddings }))
    if (v != null && typeof v !== 'boolean') throw Error(`Invalid economist ${key}`);
  const c = m.context ?? {}, r = c.retrieval ?? {}, p = c.compaction ?? {}, t = m.topology ?? {}, s = m.routing?.switch ?? {};
  for (const [key, value, min, max] of [
    ['externalizeAboveTokens', c.externalizeAboveTokens, 256, 1e6], ['previewTokens', c.previewTokens, 0, 4096],
    ['maxArtifactBytes', c.maxArtifactBytes, 1024, 16e6], ['maxStoreBytes', c.maxStoreBytes, 1024, 256e6], ['retentionDays', c.retentionDays, 1, 365],
    ['retrieval.budgetTokens', r.budgetTokens, 128, 32768], ['retrieval.minScore', r.minScore, 0, 1], ['retrieval.epsilon', r.epsilon, 0, 10],
    ['compaction.threshold', p.threshold, 0.1, 0.99], ['compaction.minFidelity', p.minFidelity, 0.95, 1],
    ['compaction.minTurns', p.minTurns, 1, 100], ['compaction.maxCheckpointTokens', p.maxCheckpointTokens, 256, 32768],
    ['topology.threshold', t.threshold, 0, 1], ['topology.timeoutMs', t.timeoutMs, 100, 300000], ['topology.maxWorkers', t.maxWorkers, 1, 4],
    ['topology.budgetUsd', t.budgetUsd, 0, 100], ['topology.budgetTokens', t.budgetTokens, 128, 100000], ['topology.maxTurns', t.maxTurns, 1, 100],
    ['switch.minExpectedGainPct', s.minExpectedGainPct, 0, 100], ['switch.minTurnsBetweenSwitches', s.minTurnsBetweenSwitches, 0, 100],
    ['switch.riskPremiumUsd', s.riskPremiumUsd, 0, 100], ['switch.uncertaintyPremiumUsd', s.uncertaintyPremiumUsd, 0, 100],
    ['adaptive.minSamples', m.adaptive?.minSamples, 30, 100000], ['adaptive.kappa', m.adaptive?.kappa, 0, 10],
    ...['maxQualityRegression', 'maxCostRegression', 'maxEceRegression'].map(k => [`rollout.${k}`, m.rollout?.[k], 0, 1]),
  ]) range(value, min, max, key);
}
