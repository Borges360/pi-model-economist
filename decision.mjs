/**
 * The ranking core, pure and synchronous: actions `(model, effort)`, the
 * hierarchical Beta posterior behind `predictSuccess`, money/latency/cache terms,
 * the four policies, value of information, feasibility of a sticky pair, routing
 * state, checkpoints, calibration, preference and exploration. `extension.mjs`
 * wires it to pi; `benchmark.mjs` replays it over an offline matrix.
 */
import { hash, redact } from './lib/core.mjs';
import {
  levels,
  levelRank,
  supportedLevels,
  clampLevel,
  effortTokens,
  requiredTier,
  difficulties,
  kinds,
  impacts,
  kindOf,
} from './routing.mjs';

export const VERIFIER_SOURCES = ['gate', 'test', 'typecheck', 'exit_code', 'ci', 'file_diff', 'judge'];
export const POLICY_RESULTS = ['selected', 'relaxed-latency', 'relaxed-budget', 'quality-floor-unmet'];
const TIER_PRIOR = [0, 0.62, 0.74, 0.84, 0.88, 0.91];
/** Cold-start pSuccess of a tier, independent of effort. */
export function tierPrior(tier) {
  const t = Math.max(1, Math.round(Number(tier) || 1));
  return Math.min(0.97, t <= 5 ? TIER_PRIOR[t] : 0.91 + 0.02 * (t - 5));
}
export const modelKey = (m) => `${m.provider}/${m.id}`;
export const modelVersion = (m) => m?.revision ?? m?.version ?? 'version-unknown';
export const actionId = (modelId, effort) => `${modelId}#${effort}`;
const finite = Number.isFinite;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function quantile(values, q) {
  const xs = values.filter(finite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const at = (xs.length - 1) * q,
    lo = Math.floor(at),
    hi = Math.ceil(at);
  return xs[lo] + (xs[hi] - xs[lo]) * (at - lo);
}
/** Hard family of an action's own Beta: `${kind}|risk:${impact}|tools:..|image:..`. */
export function familyOf(features) {
  const tools = features.requiredCapabilities.some((c) => c !== 'image') ? 'required' : 'none';
  return `${kindOf(features.intents)}|risk:${features.risk.impact}|tools:${tools}|image:${features.modality.image ? 1 : 0}`;
}
const isRisky = (features) => features.risk.categories.length > 0;

/* --------------------------- outcomes and labels --------------------------- */

/**
 * The only door through which an outcome enters the posterior. It needs a named
 * verifier; a judge counts only when trusted. Exit code 0 is success. Anything
 * the assistant says about itself is not an outcome and returns null.
 */
export function recordVerifiedOutcome(input, conf = {}, now = new Date().toISOString()) {
  if (!input || !VERIFIER_SOURCES.includes(input.source)) return null;
  if (input.source === 'judge' && !(conf.verifiers?.trustedJudges ?? []).includes(input.verifier))
    return null;
  let success;
  if (input.source === 'exit_code') {
    if (!Number.isInteger(input.exitCode)) return null;
    success = input.exitCode === 0;
  } else if (typeof input.success === 'boolean') success = input.success;
  else return null;
  if (typeof input.model !== 'string' || !input.model) return null;
  const effort = levels.includes(input.effort) ? input.effort : 'unknown';
  const occurredAt = input.occurredAt ?? now;
  return {
    id:
      input.id ??
      hash([input.taskId, input.decisionId, input.source, input.verifier, input.model, effort, occurredAt]).slice(0, 32),
    taskId: input.taskId ?? null,
    decisionId: input.decisionId ?? null,
    model: input.model,
    effort,
    version: input.version ?? 'version-unknown',
    family: input.family ?? null,
    intents: Array.isArray(input.intents) ? input.intents.filter((i) => kinds.includes(i)) : [],
    risky: input.risky === true,
    source: input.source,
    verifier: input.verifier ?? input.source,
    success,
    accepted: success,
    verified: true,
    latencyMs: finite(input.latencyMs) ? input.latencyMs : null,
    costUsd: finite(input.costUsd) ? input.costUsd : null,
    features: input.features ?? null,
    occurredAt,
  };
}
/**
 * The lowest effort of a model that passes a verifier on a task is the effort
 * label. Higher efforts that also passed are `dominated` and do not raise the
 * preference for thinking hard.
 */
export function markDominated(rows) {
  const groups = new Map();
  for (const r of rows)
    if (r.success && r.taskId && levels.includes(r.effort)) {
      const key = `${r.taskId}|${r.model}|${r.verifier ?? r.source}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
  const dominated = new Set();
  for (const group of groups.values()) {
    const min = Math.min(...group.map((r) => levelRank(r.effort)));
    for (const r of group) if (levelRank(r.effort) > min) dominated.add(r);
  }
  return rows.map((r) => ({ ...r, dominated: dominated.has(r) }));
}
/** Journal rows (new and 0.3.x) as verified outcomes; unverified rows are dropped. */
export function prepareOutcomes(rows = []) {
  const out = [];
  for (const raw of rows) {
    const r = raw?.payload ?? raw;
    if (!r || r.verified !== true || typeof r.model !== 'string') continue;
    out.push({
      ...r,
      success: typeof r.success === 'boolean' ? r.success : r.accepted !== false,
      effort: r.effort ?? '*',
      version: r.version ?? 'version-unknown',
      intents: Array.isArray(r.intents) ? r.intents : r.kind ? [r.kind] : [],
      family: r.family ?? null,
      legacy: r.effort == null,
      latencyMs: finite(r.latencyMs) ? r.latencyMs : finite(r.durationMs) ? r.durationMs : null,
    });
  }
  return markDominated(out);
}

/* ------------------------------- posterior -------------------------------- */

const decay = (row, now, halfLifeDays) => {
  const at = Date.parse(row.occurredAt ?? '');
  if (!finite(at)) return 1;
  const ageDays = Math.max(0, (now - at) / 86_400_000);
  return 0.5 ** (ageDays / (halfLifeDays || 30));
};
const tally = (rows, weight) =>
  rows.reduce(
    (t, r) => {
      const w = weight(r);
      t.n += w;
      if (!r.success) t.failures += w;
      return t;
    },
    { n: 0, failures: 0 },
  );
/** pFail = (alpha + failures) / (alpha + beta + n). */
export function betaPosterior({ n = 0, failures = 0 } = {}, { alpha = 1, beta = 3 } = {}) {
  const pFail = (alpha + failures) / (alpha + beta + n);
  const a = beta + (n - failures),
    b = alpha + failures;
  return { pFail, pSuccess: 1 - pFail, variance: (a * b) / ((a + b) ** 2 * (a + b + 1)), n };
}
const cosine = (u, v) => {
  if (!Array.isArray(u) || !Array.isArray(v) || u.length !== v.length || !u.length) return 0;
  let dot = 0,
    nu = 0,
    nv = 0;
  for (let i = 0; i < u.length; i++) {
    dot += u[i] * v[i];
    nu += u[i] ** 2;
    nv += v[i] ** 2;
  }
  return nu && nv ? dot / Math.sqrt(nu * nv) : 0;
};
const sameAction = (r, action) =>
  r.model === action.modelId &&
  !r.dominated &&
  (r.legacy || (r.effort === action.effort && r.version === action.version));
/**
 * The only function the ranking consults for pSuccess. A precision-weighted mix of
 * the action's own Beta (weight n), the same action pooled over families that
 * share an intent (weight 0.5·n_pool, plus embedder neighbours at 0.25), the tier
 * prior (weight alpha+beta) and, when enabled, a Bradley-Terry preference.
 */
export function predictSuccess(features, action, ctx = {}) {
  const { outcomes = [], stats = {}, now = Date.now(), embed = null, learned = {}, preference = null } = ctx;
  const alpha = stats.alpha ?? 1,
    beta = stats.beta ?? 3;
  const weight = (r) => decay(r, now, stats.halfLifeDays ?? 30);
  const family = familyOf(features);
  const same = outcomes.filter((r) => sameAction(r, action));
  const own = same.filter((r) => !r.legacy && r.family === family);
  const pooled = same.filter(
    (r) => !own.includes(r) && r.intents.some((i) => features.intents.includes(i)),
  );
  const ownT = tally(own, weight);
  const poolT = tally(pooled, weight);
  if (embed && learned.embeddings === 'on') {
    const anchor = embed(features);
    const neighbours = same.filter(
      (r) =>
        !own.includes(r) &&
        !pooled.includes(r) &&
        r.features &&
        cosine(anchor, embed(r.features)) >= (learned.neighborCosine ?? 0.85),
    );
    const extra = tally(neighbours, (r) => 0.25 * weight(r));
    poolT.n += extra.n;
    poolT.failures += extra.failures;
  }
  const components = [];
  if (ownT.n > 0) {
    const b = betaPosterior(ownT, { alpha, beta });
    components.push({ w: ownT.n, p: b.pSuccess, v: b.variance });
  }
  if (poolT.n > 0) {
    const b = betaPosterior(poolT, { alpha, beta });
    components.push({ w: 0.5 * poolT.n, p: b.pSuccess, v: b.variance });
  }
  const prior = tierPrior(action.tier),
    k = alpha + beta;
  components.push({ w: k, p: prior, v: (prior * (1 - prior)) / (k + 1) });
  const bt = preference?.get?.(actionId(action.modelId, action.effort));
  if (bt && bt.pairs > 0) components.push({ w: bt.pairs, p: bt.p, v: (bt.p * (1 - bt.p)) / (bt.pairs + 1) });
  const total = components.reduce((s, c) => s + c.w, 0);
  const mean = components.reduce((s, c) => s + c.w * c.p, 0) / total;
  const variance = components.reduce((s, c) => s + c.w * (c.v + (c.p - mean) ** 2), 0) / total;
  let pSuccess = mean,
    calibrated = false;
  const binned = ctx.calibration?.lookup?.(mean);
  if (finite(binned)) {
    pSuccess = binned;
    calibrated = true;
  }
  return {
    pSuccess,
    uncertainty: Math.sqrt(variance),
    ownSamples: ownT.n,
    poolSamples: poolT.n,
    calibrated,
  };
}
/** pSafe: posterior of risky outcomes only, in the same key; null below the sample floor. */
export function predictSafety(features, action, ctx = {}) {
  const { outcomes = [], stats = {}, now = Date.now() } = ctx;
  const family = familyOf(features);
  const rows = outcomes.filter(
    (r) => sameAction(r, action) && !r.legacy && r.family === family && r.risky,
  );
  if (rows.length < (stats.minSafeSamples ?? 20)) return null;
  const t = tally(rows, (r) => decay(r, now, stats.halfLifeDays ?? 30));
  return betaPosterior(t, { alpha: stats.alpha ?? 1, beta: stats.beta ?? 3 }).pSuccess;
}

/* ------------------------- money, tokens, latency ------------------------- */

export function latencyFor(action, model, outcomes = []) {
  const xs = outcomes
    .filter((r) => r.model === action.modelId && r.effort === action.effort && finite(r.latencyMs))
    .map((r) => r.latencyMs);
  if (xs.length >= 5) return { p50Ms: quantile(xs, 0.5), p95Ms: quantile(xs, 0.95), source: 'observed' };
  const prior = finite(model.latencyMs) ? model.latencyMs : 1000;
  return { p50Ms: prior, p95Ms: prior, source: 'prior' };
}
/**
 * Visible and reasoning tokens of an action. Below five samples the prior is
 * `thinking.outputTokens[effort]` with p95 = 1.8·p50. Without a reasoning split in
 * usage, the whole output counts as visible and reasoning reserves zero.
 */
export function tokenProfile(model, effort, thinking, calls = [], fallback = 2048) {
  const base = effortTokens(thinking, effort, fallback);
  const mine = calls.filter(
    (c) => c.modelId === modelKey(model) && c.effort === effort && finite(c.outputTokens),
  );
  const split = mine.filter((c) => finite(c.reasoningTokens));
  if (!split.length) {
    const visible = mine.map((c) => c.outputTokens);
    const measured = visible.length >= 5;
    return {
      visibleP50: measured ? quantile(visible, 0.5) : base,
      visibleP95: measured ? quantile(visible, 0.95) : base * 1.8,
      reasoningP50: 0,
      reasoningP95: 0,
      samples: mine.length,
      flags: ['reasoning-not-split'],
    };
  }
  if (split.length < 5) {
    const reasoning = effort === 'off' ? 0 : base;
    return {
      visibleP50: base,
      visibleP95: base * 1.8,
      reasoningP50: reasoning,
      reasoningP95: reasoning * 1.8,
      samples: split.length,
      flags: [],
    };
  }
  const visible = split.map((c) => c.outputTokens),
    reasoning = split.map((c) => c.reasoningTokens);
  return {
    visibleP50: quantile(visible, 0.5),
    visibleP95: quantile(visible, 0.95),
    reasoningP50: quantile(reasoning, 0.5),
    reasoningP95: quantile(reasoning, 0.95),
    samples: split.length,
    flags: [],
  };
}
const cachedPriceOf = (p) =>
  finite(p?.cacheRead) ? p.cacheRead : finite(p?.cachedInput) ? p.cachedInput : null;
/**
 * Money only, from what the registry publishes. Reasoning uses `cost.reasoning`
 * when present, `cost.output` otherwise (`reasoning-price-shared`). An unpublished
 * cache price makes the cache share zero (`cache-unpriced`); nothing is invented.
 */
export function priceAction(model, { input = 0, cached = 0, visible = 0, reasoning = 0, effort = 'off' } = {}) {
  const p = model?.cost;
  const flags = [];
  if (
    !p ||
    !finite(p.input) ||
    !finite(p.output) ||
    p.input < 0 ||
    p.output < 0 ||
    (p.input + p.output === 0 && !model.local)
  )
    return { usd: null, flags };
  let reasoningPrice = p.output;
  if (finite(p.reasoning)) reasoningPrice = p.reasoning;
  else if (effort !== 'off' && model.reasoning === true) flags.push('reasoning-price-shared');
  const cachedPrice = cachedPriceOf(p);
  if (cached > 0 && cachedPrice === null) flags.push('cache-unpriced');
  return {
    usd: (input * p.input + cached * (cachedPrice ?? 0) + visible * p.output + reasoning * reasoningPrice) / 1e6,
    flags,
  };
}
/**
 * Staying on the model that holds the session's cache saves its cached share;
 * switching loses it. Changing only the effort on the same model loses nothing.
 */
export function cacheTerms(model, previousModel, sessionCalls = []) {
  if (!previousModel) return { savings: 0, loss: 0, reusable: 0, hitProbability: 0, flags: [] };
  const last = [...sessionCalls]
    .reverse()
    .find((c) => c.modelId === modelKey(previousModel) && finite(c.cacheReadTokens));
  const reusable = last?.cacheReadTokens ?? 0;
  const hitProbability = reusable > 0 ? 0.5 : 0;
  const cachedPrice = cachedPriceOf(previousModel.cost);
  if (cachedPrice === null || !finite(previousModel.cost?.input))
    return { savings: 0, loss: 0, reusable, hitProbability, flags: ['cache-unpriced'] };
  const value = (reusable * Math.max(0, previousModel.cost.input - cachedPrice) * hitProbability) / 1e6;
  return modelKey(model) === modelKey(previousModel)
    ? { savings: value, loss: 0, reusable, hitProbability, flags: [] }
    : { savings: 0, loss: value, reusable, hitProbability, flags: [] };
}
export function ttftDelta(model, previousModel, calls = []) {
  if (!previousModel || modelKey(model) === modelKey(previousModel)) return { ms: 0, flags: [] };
  const mean = (m) => {
    const xs = calls.filter((c) => c.modelId === modelKey(m) && finite(c.ttftMs)).map((c) => c.ttftMs);
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  };
  const a = mean(model),
    b = mean(previousModel);
  if (a === null || b === null) return { ms: 0, flags: ['ttft-unpriced'] };
  return { ms: a - b, flags: [] };
}
export function requiredWindow(inputTokens, tokens, agentic, win = {}) {
  return (
    inputTokens +
    tokens.reasoningP95 +
    tokens.visibleP95 +
    (agentic ? (win.toolGrowth ?? 2048) : 0) +
    (win.safetyMargin ?? 512)
  );
}
/** What one policy values, on expected (ranking) or realised (benchmark) numbers. */
export function utility(policy, { pSuccess, costUsd, p95Ms }, objectives = {}) {
  if (!finite(costUsd)) return -Infinity;
  const value = objectives.successValueUsd ?? 1;
  const waiting = ((p95Ms ?? 0) / 1000) * (objectives.latencyValueUsdPerSecond ?? 0.01);
  if (policy === 'economy') return value * pSuccess - costUsd;
  if (policy === 'quality') return value * pSuccess - 0.001 * costUsd;
  if (policy === 'latency') return value * pSuccess - 10 * waiting - 0.001 * costUsd;
  return value * pSuccess - costUsd - waiting;
}
const actionUtility = (policy, a, objectives) =>
  utility(policy, { pSuccess: a.pSuccess, costUsd: a.policyCostUsd, p95Ms: a.latency.p95Ms }, objectives);
/** Stable per-model reasoning profile, logged when an action of the model is used. */
export function reasoningProfile(model, calls = [], outcomes = []) {
  const id = modelKey(model);
  const semantics =
    typeof model.reasoningSemantics === 'string'
      ? model.reasoningSemantics
      : model.thinkingLevelMap
        ? `${model.provider}:levelmap:${hash(model.thinkingLevelMap).slice(0, 12)}`
        : 'unknown';
  const empirical = {};
  for (const level of supportedLevels(model)) {
    const mine = calls.filter((c) => c.modelId === id && c.effort === level);
    const done = outcomes.filter((r) => r.model === id && r.effort === level);
    if (!mine.length && !done.length) continue;
    empirical[level] = {
      outputTokensP50: quantile(mine.map((c) => c.outputTokens), 0.5),
      outputTokensP95: quantile(mine.map((c) => c.outputTokens), 0.95),
      reasoningTokensP50: quantile(mine.map((c) => c.reasoningTokens), 0.5),
      reasoningTokensP95: quantile(mine.map((c) => c.reasoningTokens), 0.95),
      successRate: done.length ? done.filter((r) => r.success).length / done.length : null,
    };
  }
  return {
    supported: model.reasoning === true,
    levels: supportedLevels(model),
    providerSemantics: semantics,
    empirical,
  };
}

/* --------------------------------- actions -------------------------------- */

/** Efforts one model contributes. Only `auto` enumerates; an ace pins one level. */
export function effortsFor(model, thinking = {}, { selectedLevel = 'off', forceEffort = null } = {}) {
  const mode = thinking.mode ?? 'auto';
  if (forceEffort) return [clampLevel(forceEffort, model)];
  if (mode === 'follow') return [clampLevel(selectedLevel ?? 'off', model)];
  if (mode === 'fixed') return [clampLevel(thinking.fixed ?? 'medium', model)];
  if (model.scopedLevel) return [clampLevel(model.scopedLevel, model)];
  const ceiling = thinking.ceiling ?? 'high';
  return supportedLevels(model).filter(
    (l) => ceiling === 'max' || levelRank(l) <= levelRank(ceiling),
  );
}
/** Whether an action counts as "reasoning" for the risk guardrail. */
const reasons = (model, effort, thinking) =>
  model.reasoning === true &&
  ((thinking.mode ?? 'auto') !== 'auto' || model.scopedLevel || effort !== 'off');
/**
 * Eligibility first, preference second. Every action that fails a filter is
 * rejected with its reasons and never ranked. Survivors carry pSuccess, pSafe,
 * money, latency, cache and uncertainty as separate quantities.
 */
export function rankActions(pool, a, conf, env = {}) {
  const {
    outcomes = [],
    calls = [],
    sessionCalls = calls,
    previousModel = null,
    classifierCost = 0,
    selectedLevel = 'off',
    exclude = new Set(),
    excludeModels = new Set(),
    restrictModels = null,
    forceEffort = null,
    remainingBudget = Infinity,
    executorPolicy = conf.executor?.dataPolicy ?? 'allow',
    now = Date.now(),
    embed = null,
    preference = null,
    calibration = null,
    inputTokensByModel = null,
  } = env;
  const thinking = conf.thinking ?? {};
  const stats = conf.stats ?? {};
  const objectives = conf.objectives ?? {};
  const features = a.features;
  const family = familyOf(features);
  const tier = requiredTier(a, conf);
  const risky = a.risks.length > 0 || a.difficulty === 'critical';
  const guard = risky && thinking.requireReasoningOnRisk !== false;
  const accepted = [],
    rejected = [];
  const predictCtx = { outcomes, stats, now, embed, learned: conf.learned ?? {}, preference, calibration };
  for (const m of pool) {
    const id = modelKey(m);
    const shared = [];
    if (m.api === 'pi-virtual') shared.push('virtual');
    if (m.auth === false) shared.push('authentication');
    if (!finite(m.tier) || m.tier < 1) shared.push('unverified-tier');
    if ((m.tier ?? 1) < tier) shared.push('tier');
    if (m.health === false) shared.push('health');
    if (a.requiresTools && m.tools !== true) shared.push('tool-compatibility-unverified');
    if (a.requiresImageInput && !m.input?.includes('image')) shared.push('image');
    if (m.dataAllowed === false || (executorPolicy === 'deny' && m.local !== true)) shared.push('privacy');
    if (excludeModels.has(id)) shared.push('retry-excluded');
    if (restrictModels && !restrictModels.has(id)) shared.push('not-fallback-provider');
    const input = inputTokensByModel?.get(id) ?? a.estimatedInputTokens;
    for (const effort of [...new Set(effortsFor(m, thinking, { selectedLevel, forceEffort }))]) {
      const reason = [...shared];
      const action = { modelId: id, effort, version: modelVersion(m), tier: m.tier ?? 1 };
      if (exclude.has(actionId(id, effort))) reason.push('retry-excluded');
      const tokens = tokenProfile(m, effort, thinking, calls, a.estimatedOutputTokens);
      const need = requiredWindow(input, tokens, features.task.agentic, conf.window ?? {});
      if (finite(m.contextWindow) && need > m.contextWindow) reason.push('context');
      const pSafe = risky ? predictSafety(features, action, predictCtx) : null;
      if (guard && pSafe === null && (!reasons(m, effort, thinking) || (m.tier ?? 1) < conf.minRiskTier))
        reason.push('reasoning-unavailable');
      if (pSafe !== null && pSafe < (objectives.safetyThreshold ?? 0.9)) reason.push('unsafe');
      if (reason.length) {
        rejected.push({ model: id, thinkingLevel: effort, tier: m.tier ?? 1, reasonCodes: [...new Set(reason)] });
        continue;
      }
      const prediction = predictSuccess(features, action, predictCtx);
      const price = priceAction(m, {
        input,
        visible: tokens.visibleP50,
        reasoning: tokens.reasoningP50,
        effort,
      });
      const cache = cacheTerms(m, previousModel, sessionCalls);
      const ttft = ttftDelta(m, previousModel, calls);
      const latency = latencyFor(action, m, outcomes);
      const pFail = 1 - prediction.pSuccess;
      const flags = [...tokens.flags, ...price.flags, ...cache.flags, ...ttft.flags];
      if (inputTokensByModel && !inputTokensByModel.has(id)) flags.push('token-estimate-fallback');
      if (latency.source === 'prior') flags.push('latency-prior');
      accepted.push({
        id: actionId(id, effort),
        model: m,
        modelId: id,
        effort,
        thinkingLevel: effort,
        tier: m.tier ?? 1,
        version: action.version,
        family,
        pSuccess: prediction.pSuccess,
        pSafe,
        uncertainty: prediction.uncertainty,
        calibrated: prediction.calibrated,
        samples: prediction.ownSamples,
        poolSamples: prediction.poolSamples,
        measured: prediction.ownSamples > 0,
        baseCostUsd: price.usd,
        classifierCostUsd: classifierCost,
        latency: { p50Ms: latency.p50Ms + ttft.ms, p95Ms: latency.p95Ms + ttft.ms },
        latencySource: latency.source,
        expectedRetries: pFail >= 1 ? conf.maxRetries : Math.min(conf.maxRetries, pFail / (1 - pFail)),
        expectedCacheSavingsUsd: cache.savings,
        expectedCacheLossUsd: cache.loss,
        expectedTtftDeltaMs: ttft.ms,
        requiredWindow: need,
        contextPressure: finite(m.contextWindow) && m.contextWindow > 0 ? need / m.contextWindow : null,
        inputTokens: input,
        outputTokens: tokens.visibleP50 + tokens.reasoningP50,
        tokens,
        flags,
      });
    }
  }
  const auto = (thinking.mode ?? 'auto') === 'auto';
  for (const act of accepted) {
    const pFail = 1 - act.pSuccess;
    const higher = auto
      ? accepted
          .filter((x) => x.modelId === act.modelId && levelRank(x.effort) > levelRank(act.effort))
          .sort((x, y) => levelRank(x.effort) - levelRank(y.effort))[0]
      : null;
    const other = accepted
      .filter((x) => x.modelId !== act.modelId && finite(x.baseCostUsd))
      .sort((x, y) => x.baseCostUsd - y.baseCostUsd)[0];
    const next = higher && finite(higher.baseCostUsd) ? higher : other;
    act.recoverySource = next ? 'next-action' : 'self';
    if (act.baseCostUsd === null) {
      act.expectedRecoveryCostUsd = null;
      act.predictedCostUsd = null;
      act.policyCostUsd = null;
    } else {
      act.expectedRecoveryCostUsd = pFail * (next ? next.baseCostUsd : act.baseCostUsd);
      act.predictedCostUsd = act.baseCostUsd + classifierCost + act.expectedRecoveryCostUsd;
      act.policyCostUsd = Math.max(
        0,
        act.predictedCostUsd - act.expectedCacheSavingsUsd + act.expectedCacheLossUsd,
      );
    }
    act.expectedTotalCost = act.policyCostUsd;
  }
  const kept = [];
  for (const act of accepted) {
    if (finite(remainingBudget) && (act.policyCostUsd === null || act.policyCostUsd > remainingBudget))
      rejected.push({ model: act.modelId, thinkingLevel: act.effort, tier: act.tier, reasonCodes: ['budget'] });
    else kept.push(act);
  }
  return { accepted: kept, rejected, family, requiredTier: tier, risky, guard };
}

/* --------------------------------- policies -------------------------------- */

/**
 * The four policies, only over actions that passed the filters. Empty sets relax
 * the latency cap, then the soft budget; quality floor and safety threshold are
 * never relaxed. Returns the ranked feasible set and how it was obtained.
 */
export function selectAction(actions, { policy = 'balanced', floor = 0.7, safetyThreshold = 0.9, remainingBudget = Infinity, objectives = {}, preferredModel = null, preferredEffort = null, allowPreferenceFallback = false } = {}) {
  const cost = (a) => (finite(a.policyCostUsd) ? a.policyCostUsd : Infinity);
  const safe = (a) => a.pSafe == null || a.pSafe >= safetyThreshold;
  const passes = (a) => a.pSuccess >= floor && safe(a);
  const byId = (x, y) => cmp(x.id, y.id);
  const lv = objectives.latencyValueUsdPerSecond ?? 0.01;
  const latencyCap =
    policy === 'quality'
      ? objectives.quality?.latencyCapMs
      : policy === 'balanced'
        ? objectives.balanced?.targetLatencyMs
        : null;
  const softBudget =
    policy === 'balanced' && finite(objectives.balanced?.softBudgetUsd)
      ? objectives.balanced.softBudgetUsd
      : null;
  const attempt = (useLatency, useSoft) => {
    let set = actions.filter((a) => passes(a) && cost(a) <= remainingBudget);
    if (useSoft && softBudget !== null) set = set.filter((a) => cost(a) <= softBudget);
    if (useLatency && finite(latencyCap)) set = set.filter((a) => a.latency.p95Ms <= latencyCap);
    if (!set.length) return null;
    if (policy === 'economy')
      return [...set].sort(
        (x, y) => cmp(cost(x), cost(y)) || y.pSuccess - x.pSuccess || x.latency.p95Ms - y.latency.p95Ms || byId(x, y),
      );
    if (policy === 'quality')
      return [...set].sort(
        (x, y) => y.pSuccess - x.pSuccess || cmp(cost(x), cost(y)) || x.latency.p95Ms - y.latency.p95Ms || byId(x, y),
      );
    if (policy === 'latency')
      return [...set].sort(
        (x, y) => x.latency.p95Ms - y.latency.p95Ms || cmp(cost(x), cost(y)) || y.pSuccess - x.pSuccess || byId(x, y),
      );
    const best = Math.max(...set.map((a) => a.pSuccess));
    const tie = objectives.balanced?.successTie ?? 0.02;
    const score = (a) => cost(a) + (a.latency.p95Ms / 1000) * lv;
    const order = (x, y) =>
      cmp(score(x), score(y)) || y.pSuccess - x.pSuccess || x.latency.p95Ms - y.latency.p95Ms || byId(x, y);
    const band = set.filter((a) => a.pSuccess >= best - tie).sort(order);
    return [...band, ...set.filter((a) => !band.includes(a)).sort(order)];
  };
  for (const [useLatency, useSoft, policyResult] of [
    [true, true, 'selected'],
    [false, true, 'relaxed-latency'],
    [false, false, 'relaxed-budget'],
  ]) {
    const ranked = attempt(useLatency, useSoft);
    if (ranked) {
      const modelActions = preferredModel ? ranked.filter((action) => action.modelId === preferredModel) : [];
      const preferred = preferredModel
        ? modelActions.find((action) => !preferredEffort || action.effort === preferredEffort) ?? modelActions[0]
        : preferredEffort
          ? ranked.find((action) => action.effort === preferredEffort)
          : null;
      if (preferred)
        return {
          selected: preferred,
          ranked: [preferred, ...ranked.filter((action) => action !== preferred)],
          policyResult,
          rolePreferenceResult: 'preferred',
          roleEffortResult: preferredEffort && preferred.effort !== preferredEffort ? 'fallback' : preferredEffort ? 'preferred' : 'automatic',
          floor,
        };
      if ((preferredModel || preferredEffort) && !allowPreferenceFallback)
        return {
          selected: null,
          ranked: [],
          policyResult: 'role-preference-unavailable',
          rolePreferenceResult: 'unavailable',
          roleEffortResult: preferredEffort ? 'unavailable' : 'automatic',
          floor,
        };
      const fallback = preferredEffort ? ranked.find((action) => action.effort === preferredEffort) : null;
      return {
        selected: fallback ?? ranked[0],
        ranked: fallback ? [fallback, ...ranked.filter((action) => action !== fallback)] : ranked,
        policyResult,
        rolePreferenceResult: preferredModel || preferredEffort ? 'fallback' : 'automatic',
        roleEffortResult: preferredEffort ? (fallback ? 'preferred' : 'fallback') : 'automatic',
        floor,
      };
    }
  }
  return {
    selected: null,
    ranked: [],
    policyResult: preferredModel && !allowPreferenceFallback ? 'role-preference-unavailable' : 'quality-floor-unmet',
    rolePreferenceResult: preferredModel ? (allowPreferenceFallback ? 'fallback-unavailable' : 'unavailable') : 'automatic',
    floor,
  };
}
/**
 * The fast set: the cheap group whose pSuccess clears the floor with margin.
 * Callers only ask when no risk, checkpoint, tool failure or uninspected image
 * blocks the fast phase.
 */
export function fastSet(accepted, { floor, margin = 0.05, executionModels = [] } = {}) {
  const priced = accepted.filter((a) => finite(a.policyCostUsd));
  if (!priced.length) return null;
  const cheapest = priced.reduce((x, y) => (y.policyCostUsd < x.policyCostUsd ? y : x));
  if (cheapest.pSuccess < floor + margin) return null;
  let set = priced.filter((a) => a.tier <= cheapest.tier && a.pSuccess >= floor + margin);
  if (executionModels.length) {
    const restricted = set.filter((a) => executionModels.includes(a.modelId));
    if (restricted.length) set = restricted;
  }
  return { set, cheapest };
}

/* --------------------------- value of information -------------------------- */

/** Label hypotheses the classifier could return, already above the floor. */
export function labelAlternatives(a) {
  const alternatives = [];
  for (const d of difficulties)
    if (d !== a.difficulty && !(a.difficultyFloor && difficulties.indexOf(d) < difficulties.indexOf(a.difficultyFloor)))
      alternatives.push({ label: `difficulty:${d}`, patch: { difficulty: d } });
  if (!a.requiresTools) alternatives.push({ label: 'tools:true', patch: { tools: true } });
  for (const k of kinds) if (!a.intents.includes(k)) alternatives.push({ label: `intent:${k}`, patch: { intents: [k] } });
  for (const impact of impacts)
    if (impacts.indexOf(impact) > impacts.indexOf(a.features.risk.impact))
      alternatives.push({ label: `riskImpact:${impact}`, patch: { riskImpact: impact } });
  return alternatives;
}
/**
 * Gate of `hybrid` and `learned`: call when a plausible label moves the winner,
 * the margin is thin or the cost gap is material, and the loss avoided is worth
 * the classifier's price and wait. A label that crosses a capability or tier
 * boundary is called even when the loss estimate is small.
 */
export function shouldClassify({ base, alternatives = [], price = 0, classifier = {}, objectives = {} }) {
  const minMargin = classifier.minUtilityMargin ?? 0.05;
  const reasons = [];
  const modelOf = (id) => String(id).split('#')[0];
  const changed = alternatives.filter(
    (x) => x.winnerId && base.firstId && modelOf(x.winnerId) !== modelOf(base.firstId),
  );
  // No plausible label moves the route to another model: nothing to learn.
  if (!changed.length) return { call: false, reason: 'classifier-skipped-no-voi', reasons, margin: null, gap: 0 };
  reasons.push('label-changes-winner');
  const margin = base.secondUtility == null ? Infinity : base.firstUtility - base.secondUtility;
  if (margin < minMargin) reasons.push('low-margin');
  let gap = 0;
  if (finite(base.firstCost) && finite(base.secondCost)) {
    gap = Math.abs(base.secondCost - base.firstCost);
    const relative = gap / Math.max(Math.min(base.firstCost, base.secondCost), 1e-12);
    if (relative >= (classifier.materialCostGap ?? 0.25) || gap >= 2 * price) reasons.push('material-cost-gap');
  }
  const crossing = changed.some(
    (x) => x.requiredTier !== base.requiredTier || x.requiredCaps !== base.requiredCaps,
  );
  const avoided = Math.max(
    0,
    ...changed.map((x) => x.gain ?? 0),
    reasons.includes('material-cost-gap') ? gap : 0,
    margin < minMargin ? minMargin - margin : 0,
  );
  const threshold = price + ((classifier.timeoutMs ?? 2500) / 1000) * (objectives.latencyValueUsdPerSecond ?? 0.01);
  if (avoided < threshold && !crossing)
    return { call: false, reason: 'classifier-skipped-no-voi', reasons, margin, gap, avoided, threshold };
  return { call: true, reasons, margin, gap, avoided, threshold, crossing };
}
export { actionUtility };

/* --------------------------------- explore -------------------------------- */

/**
 * Bandit choice beside the greedy one. Hard risk sets kappa to zero. A different
 * action is taken only within the premium and once per family per session.
 */
export function explore(ranked, greedy, { policy, objectives = {}, kappa = 0.15, hardRisk = false, remainingBudget = Infinity, maxPremium = 0.1, alreadyExplored = false } = {}) {
  if (!greedy) return { exploreChoice: null, shadowChoice: null };
  const k = hardRisk ? 0 : kappa;
  const base = greedy.policyCostUsd;
  const pool = ranked.filter(
    (a) =>
      finite(a.policyCostUsd) &&
      a.policyCostUsd <= remainingBudget &&
      (!finite(base) || a.policyCostUsd - base <= Math.abs(base) * maxPremium),
  );
  const score = (a) => actionUtility(policy, a, objectives) + k * a.uncertainty;
  let exploreChoice = greedy;
  for (const a of pool) if (score(a) > score(exploreChoice) + 1e-12) exploreChoice = a;
  const shadowChoice = alreadyExplored || k === 0 ? greedy : exploreChoice;
  return { exploreChoice, shadowChoice };
}

/** Keep active exploration inside any model or effort selected by a role preference. */
export function constrainRoleExploration(actions, greedy, { modelPreferred = false, effortPreferred = false } = {}) {
  if (!greedy || (!modelPreferred && !effortPreferred)) return actions;
  return actions.filter(
    (action) =>
      (!modelPreferred || action.modelId === greedy.modelId) &&
      (!effortPreferred || action.effort === greedy.effort),
  );
}

/* ------------------------------ calibration ------------------------------- */

/** Bins [0,0.2) … [0.8,1] with n, verified hit rate and expected calibration error. */
export function calibrationReport(pairs = [], { minSamples = 30 } = {}) {
  const bins = [0, 0.2, 0.4, 0.6, 0.8].map((lo) => ({ lo, hi: lo + 0.2, n: 0, hits: 0, sumP: 0 }));
  for (const { p, success } of pairs) {
    if (!finite(p) || typeof success !== 'boolean') continue;
    const bin = bins[Math.min(4, Math.max(0, Math.floor(p / 0.2)))];
    bin.n++;
    bin.sumP += p;
    if (success) bin.hits++;
  }
  const total = bins.reduce((s, b) => s + b.n, 0);
  const rows = bins.map((b) => ({
    range: `[${b.lo.toFixed(1)},${b.hi.toFixed(1)}${b.hi >= 1 ? ']' : ')'}`,
    n: b.n,
    frequency: b.n ? b.hits / b.n : null,
    meanPredicted: b.n ? b.sumP / b.n : null,
  }));
  const ece = total
    ? rows.reduce((s, r) => s + (r.n ? (r.n / total) * Math.abs(r.frequency - r.meanPredicted) : 0), 0)
    : null;
  return {
    bins: rows,
    n: total,
    ece,
    lookup(p) {
      if (!finite(p)) return null;
      const row = rows[Math.min(4, Math.max(0, Math.floor(p / 0.2)))];
      return row.n >= minSamples ? row.frequency : null;
    },
  };
}

/* ------------------------------- preference ------------------------------- */

/**
 * Pairs from tasks with two verified outcomes of different actions. The winner
 * is the action that succeeded; if both did, the cheaper one.
 */
export function preferencePairs(outcomes = []) {
  const byTask = new Map();
  for (const r of outcomes)
    if (r.taskId && levels.includes(r.effort)) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const pairs = [];
  for (const rows of byTask.values()) {
    const actions = new Map();
    for (const r of rows) actions.set(actionId(r.model, r.effort), r);
    const list = [...actions.entries()];
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const [ia, a] = list[i],
          [ib, b] = list[j];
        if (a.success && !b.success) pairs.push({ winner: ia, loser: ib });
        else if (b.success && !a.success) pairs.push({ winner: ib, loser: ia });
        else if (a.success && b.success && finite(a.costUsd) && finite(b.costUsd) && a.costUsd !== b.costUsd)
          pairs.push(a.costUsd < b.costUsd ? { winner: ia, loser: ib } : { winner: ib, loser: ia });
      }
  }
  return pairs;
}
/** Bradley-Terry strengths by minorise-maximise; p is the win rate against an average action. */
export function bradleyTerry(pairs = [], iterations = 100) {
  const ids = [...new Set(pairs.flatMap((p) => [p.winner, p.loser]))];
  const theta = new Map(ids.map((id) => [id, 1]));
  const wins = new Map(ids.map((id) => [id, 0]));
  const count = new Map(ids.map((id) => [id, 0]));
  for (const p of pairs) {
    wins.set(p.winner, wins.get(p.winner) + 1);
    count.set(p.winner, count.get(p.winner) + 1);
    count.set(p.loser, count.get(p.loser) + 1);
  }
  for (let it = 0; it < iterations; it++) {
    for (const id of ids) {
      let denominator = 0;
      for (const p of pairs)
        if (p.winner === id || p.loser === id) {
          const other = p.winner === id ? p.loser : p.winner;
          denominator += 1 / (theta.get(id) + theta.get(other));
        }
      theta.set(id, Math.max(1e-6, (wins.get(id) + 0.5) / Math.max(denominator, 1e-12)));
    }
    const g = Math.exp(ids.reduce((s, id) => s + Math.log(theta.get(id)), 0) / Math.max(ids.length, 1));
    for (const id of ids) theta.set(id, theta.get(id) / g);
  }
  return new Map(ids.map((id) => [id, { p: theta.get(id) / (theta.get(id) + 1), pairs: count.get(id) }]));
}

/* ------------------------- routing state, checkpoints ------------------------ */

const WRITE_TOOL = /^(write|edit|multi_?edit|apply_?patch|create_?file|str_replace)/i;
const READ_TOOL = /^(read|grep|find|ls|glob|search|view|cat)/i;
const VERIFIER_TOOL = /test|jest|vitest|pytest|mocha|typecheck|tsc\b|lint|\bci\b|gate|diff|judge|build/i;
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('\n');
function classifyObservation(message, command = '') {
  const name = String(message.toolName ?? message.name ?? '');
  const exit = message.details?.exitCode ?? message.details?.exit_code;
  const failed = message.isError === true || (Number.isInteger(exit) && exit !== 0);
  const probe = `${name} ${command} ${message.details?.command ?? ''}`;
  const testy = /test|jest|vitest|pytest|mocha|typecheck|tsc\b|\bci\b/i.test(probe);
  return {
    type: failed ? (testy ? 'test_failure' : 'command_failure') : testy ? 'test_pass' : 'unknown',
    verified: Number.isInteger(exit) || VERIFIER_TOOL.test(probe),
    tool: WRITE_TOOL.test(name) ? 'write' : READ_TOOL.test(name) ? 'read' : 'command',
    failed,
    exitCode: Number.isInteger(exit) ? exit : null,
    text: textOf(message.content).slice(0, 500),
  };
}
/** What the conversation already did: tool rounds, last observation, files written. */
export function scanMessages(messages = []) {
  const paths = new Set();
  const commands = new Map();
  let toolRounds = 0,
    failures = 0,
    last = null,
    fileToolSeen = false,
    wrote = false,
    verifierSeen = false;
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.content))
      for (const block of message.content) {
        if (!['toolCall', 'tool_use', 'toolUse'].includes(block?.type)) continue;
        const name = String(block.name ?? block.toolName ?? '');
        const args = block.arguments ?? block.input ?? {};
        if (block.id) commands.set(block.id, typeof args.command === 'string' ? args.command : '');
        if (WRITE_TOOL.test(name) || READ_TOOL.test(name)) fileToolSeen = true;
        if (WRITE_TOOL.test(name)) {
          wrote = true;
          const path = args.path ?? args.file_path ?? args.filePath;
          if (typeof path === 'string' && path) paths.add(path);
        }
      }
    if (message?.role === 'toolResult' || message?.role === 'tool') {
      toolRounds++;
      last = classifyObservation(message, commands.get(message.toolCallId) ?? '');
      if (last.failed) failures++;
      if (last.verified) verifierSeen = true;
      if (last.tool !== 'command') fileToolSeen = true;
    }
  }
  return { toolRounds, failures, last, fileToolSeen, wrote, verifierSeen, filesTouched: paths.size };
}
/**
 * The audited routing state. File paths are counted, never stored; the observation
 * excerpt is redacted and only leaves the machine as the classifier policy allows.
 */
export function buildRoutingState(request = {}, priorRoute = null, { assessment, scan = scanMessages(request.messages ?? []), availableTools = [], workspace = false, envelope = null, failedGate = false } = {}) {
  const f = assessment.features;
  const obs = scan.last;
  const previousAttempt = priorRoute?.previousAttempt ?? null;
  const productionHit = /production|produção|\bprod\b/i;
  const environment =
    envelope?.environment ??
    (f.risk.categories.includes('production') || (obs && productionHit.test(obs.text)) ? 'production' : 'unknown');
  const progress =
    failedGate || ['gate_rejected', 'quality'].includes(previousAttempt?.outcome)
      ? 'recovery'
      : obs?.failed
        ? 'repair'
        : scan.toolRounds === 0 && (f.intents.includes('design') || f.intents.includes('search'))
          ? 'planning'
          : scan.wrote || (scan.toolRounds > 0 && f.intents.includes('edit'))
            ? 'implementation'
            : envelope?.parentPhase && ['planning', 'implementation', 'repair', 'recovery'].includes(envelope.parentPhase)
              ? envelope.parentPhase
              : 'unknown';
  return {
    intents: f.intents,
    requiredCapabilities: f.requiredCapabilities,
    environment,
    artifacts: {
      repo: Boolean(envelope?.artifacts?.repo ?? (workspace || scan.fileToolSeen)),
      filesTouched: Math.max(scan.filesTouched, Number(envelope?.artifacts?.filesTouched) || 0),
    },
    lastObservation: obs
      ? { type: obs.type, verified: obs.verified, failures: scan.failures, tool: obs.tool, failed: obs.failed, text: redact(obs.text) }
      : null,
    taskProgress: progress,
    previousAttempt,
    risks: f.risk.categories,
    contextPressure: null,
    availableTools: (envelope?.availableTools ?? availableTools).filter((t) => typeof t === 'string'),
  };
}
/** Checkpoints that break stickiness and force a full decision. */
export function checkpoints({ state, assessment, scan, latestImage = false }) {
  const list = [];
  const intents = assessment.intents;
  const obs = state.lastObservation;
  if ((intents.includes('design') || intents.includes('search')) && scan.toolRounds === 0) list.push('plan');
  if (obs?.failed && obs.type !== 'test_failure') list.push('tool_failure');
  if (
    (intents.includes('edit') || assessment.features.capabilities.fileWrite === 'required') &&
    obs &&
    !obs.failed &&
    obs.tool === 'read'
  )
    list.push('before_edit');
  if (obs?.type === 'test_failure') list.push('test_rejected');
  if (['gate_rejected', 'quality'].includes(state.previousAttempt?.outcome)) list.push('recovery');
  if (latestImage) list.push('image');
  return list;
}
const FIX = {
  image: 'escolha um modelo com visão em /model ou adicione um ao pool com /economist candidates add',
  context: 'compacte com /compact ou escolha um modelo de janela maior',
  authentication: 'autentique o provedor com /login',
  unavailable: 'autentique o provedor com /login ou troque com /model',
  'out-of-scope': 'adicione-o em /scoped-models ou rode /economist scope all',
  health: 'escolha outro modelo com /model',
  privacy: 'revise executor.dataPolicy ou dataAllowed do candidato',
  'tool-compatibility-unverified': 'marque tools com /economist candidates add <modelo> <tier> --tools on',
  'reasoning-unavailable': 'escolha um modelo que pensa, com esforço acima de off',
  budget: 'aumente /economist budget task <valor> USD',
  virtual: 'escolha um modelo físico com /model',
};
export const fixHint = (codes) => codes.map((c) => FIX[c]).filter(Boolean).join('; ');
/**
 * Synchronous check before a sticky, retried or manual pair is reused. It never
 * ranks; it only says whether the old pair still fits this request.
 */
export function validateFeasibility(pair, need = {}, env = {}) {
  const m = pair?.model;
  if (!m) return { ok: false, reasons: ['missing'] };
  const id = modelKey(m);
  const reasonCodes = [];
  if (m.api === 'pi-virtual') reasonCodes.push('virtual');
  if (m.auth === false || env.hasAuth?.(m) === false) reasonCodes.push('authentication');
  if (env.available && !env.available.includes(id)) reasonCodes.push('unavailable');
  if (env.scope && !env.scope.has(id)) reasonCodes.push('out-of-scope');
  if (m.health === false) reasonCodes.push('health');
  if (m.dataAllowed === false || (env.executorPolicy === 'deny' && m.local !== true)) reasonCodes.push('privacy');
  if (need.image && !m.input?.includes('image')) reasonCodes.push('image');
  if (need.tools && (env.strictTools ? m.tools !== true : m.tools === false))
    reasonCodes.push('tool-compatibility-unverified');
  if (finite(need.requiredWindow) && finite(m.contextWindow) && need.requiredWindow > m.contextWindow)
    reasonCodes.push('context');
  if (need.requireReasoning && !(m.reasoning === true && pair.thinkingLevel !== 'off'))
    reasonCodes.push('reasoning-unavailable');
  if (
    finite(env.remainingBudget) &&
    (env.remainingBudget <= 0 || (finite(need.predictedCostUsd) && need.predictedCostUsd > env.remainingBudget))
  )
    reasonCodes.push('budget');
  return { ok: reasonCodes.length === 0, reasons: reasonCodes, model: id, thinkingLevel: pair.thinkingLevel ?? null };
}

/* -------------------------------- telemetry ------------------------------- */

/**
 * What a `model-routes` row may hold. `deny` keeps ids, enums, numbers and hashes:
 * no observation excerpt and no caption. `redact` and `allow` redact them.
 */
export function telemetryView(row, policy = 'redact') {
  const copy = structuredClone(row);
  const scrub = (holder, key) => {
    if (!holder || typeof holder[key] !== 'string') return;
    if (policy === 'deny') {
      holder[`${key}Hash`] = hash(holder[key]).slice(0, 16);
      delete holder[key];
    } else holder[key] = redact(holder[key]);
  };
  scrub(copy.routingState?.lastObservation, 'text');
  scrub(copy, 'caption');
  return copy;
}
