import { assess, kindOf, defaults } from './routing.mjs';
import {
  actionId,
  calibrationReport,
  familyOf,
  predictSafety,
  predictSuccess,
  prepareOutcomes,
  quantile,
  selectAction,
  utility,
} from './decision.mjs';

export const MATRIX_LIMIT = 1000;
const POLICIES = ['economy', 'balanced', 'quality', 'latency'];
const finite = (n) => Number.isFinite(n);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Validates one matrix row: a task and every action already measured on it. */
function normalizeRow(raw, index) {
  if (!raw || typeof raw !== 'object') throw Error(`linha ${index + 1}: objeto esperado`);
  const actions = raw.actions ?? raw.results;
  if (!Array.isArray(actions) || !actions.length)
    throw Error(`linha ${index + 1}: actions[] com ao menos um par medido`);
  return {
    id: String(raw.id ?? raw.taskId ?? index),
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    occurredAt: typeof raw.occurredAt === 'string' ? raw.occurredAt : null,
    index,
    actions: actions.map((a, j) => {
      if (typeof a?.model !== 'string' || typeof a.success !== 'boolean' || !finite(a.costUsd) || a.costUsd < 0)
        throw Error(`linha ${index + 1}, ação ${j + 1}: model, success e costUsd ≥ 0 são obrigatórios`);
      return {
        model: a.model,
        effort: typeof a.effort === 'string' ? a.effort : 'off',
        tier: Number.isInteger(a.tier) ? a.tier : 1,
        version: a.version ?? 'version-unknown',
        success: a.success,
        costUsd: a.costUsd,
        latencyMs: finite(a.latencyMs) ? a.latencyMs : null,
        estimatedCostUsd: finite(a.estimatedCostUsd) ? a.estimatedCostUsd : null,
        estimatedLatencyMs: finite(a.estimatedLatencyMs) ? a.estimatedLatencyMs : null,
      };
    }),
  };
}
const realised = (policy, a, objectives) =>
  utility(policy, { pSuccess: a.success ? 1 : 0, costUsd: a.costUsd, p95Ms: a.latencyMs ?? 0 }, objectives);
const outcomeRows = (row, a) =>
  row.actions.map((x) => ({
    id: `${row.id}|${actionId(x.model, x.effort)}`,
    taskId: row.id,
    model: x.model,
    effort: x.effort,
    version: x.version,
    family: familyOf(a.features),
    intents: a.features.intents,
    risky: a.risks.length > 0,
    source: 'benchmark',
    verifier: 'matrix',
    success: x.success,
    accepted: x.success,
    verified: true,
    costUsd: x.costUsd,
    latencyMs: x.latencyMs,
    occurredAt: row.occurredAt,
  }));

/**
 * Offline benchmark over a supplied matrix (task × measured action). It never
 * calls a model: the router predicts from earlier rows only (prequential), or
 * from rows before `holdoutBefore`, and the matrix supplies what really happened.
 */
export function benchmarkMatrix(rows, { conf = defaults.modelEconomist, holdoutBefore = null, policies = POLICIES, seed = 12345, resamples = 1000, now = null } = {}) {
  if (!Array.isArray(rows)) throw Error('A matriz precisa ser uma lista de linhas JSONL');
  if (rows.length > MATRIX_LIMIT) throw Error(`Limite da matriz: ${MATRIX_LIMIT} linhas`);
  for (const p of policies) if (!POLICIES.includes(p)) throw Error(`Política desconhecida: ${p}`);
  const cut = holdoutBefore == null ? null : Date.parse(holdoutBefore);
  if (holdoutBefore != null && !finite(cut)) throw Error('--holdout-before precisa de uma data ISO');
  const objectives = conf.objectives ?? defaults.modelEconomist.objectives;
  const stats = conf.stats ?? defaults.modelEconomist.stats;
  const data = rows
    .map(normalizeRow)
    .sort((x, y) => (Date.parse(x.occurredAt ?? '') || 0) - (Date.parse(y.occurredAt ?? '') || 0) || x.index - y.index)
    .map((r) => ({ ...r, assessment: assess(r.prompt) }));
  let train = [],
    test = data,
    undated = 0;
  if (cut != null) {
    train = data.filter((r) => r.occurredAt && Date.parse(r.occurredAt) < cut);
    test = data.filter((r) => r.occurredAt && Date.parse(r.occurredAt) >= cut);
    undated = data.filter((r) => !r.occurredAt).length;
  }
  const clock = now ?? (cut != null ? cut : Date.now());
  const results = {};
  for (const policy of policies) {
    const history = train.flatMap((r) => outcomeRows(r, r.assessment));
    const picks = [];
    for (const row of test) {
      const a = row.assessment;
      const outcomes = prepareOutcomes(history);
      const family = familyOf(a.features);
      const priced = row.actions.map((x) => {
        const seen = outcomes.filter((o) => o.model === x.model && o.effort === x.effort);
        const costs = seen.map((o) => o.costUsd).filter(finite);
        const lat = seen.map((o) => o.latencyMs).filter(finite);
        const action = { id: actionId(x.model, x.effort), modelId: x.model, effort: x.effort, tier: x.tier, version: x.version, family };
        const ps = predictSuccess(a.features, action, { outcomes, stats, now: clock, learned: conf.learned });
        const costSource = costs.length ? 'observed-history' : x.estimatedCostUsd != null ? 'estimate' : 'unknown';
        return {
          ...action,
          pSuccess: ps.pSuccess,
          pSafe: predictSafety(a.features, action, { outcomes, stats, now: clock }),
          policyCostUsd: costs.length ? mean(costs) : (x.estimatedCostUsd ?? Infinity),
          costSource,
          latency: lat.length
            ? { p50Ms: quantile(lat, 0.5), p95Ms: quantile(lat, 0.95) }
            : { p50Ms: x.estimatedLatencyMs ?? 1000, p95Ms: x.estimatedLatencyMs ?? 1000 },
          truth: x,
        };
      });
      const floor = objectives.qualityFloor?.[a.difficulty] ?? 0.7;
      const sel = selectAction(priced, {
        policy,
        floor,
        safetyThreshold: objectives.safetyThreshold ?? 0.9,
        objectives,
      });
      const oracle = [...row.actions].sort(
        (x, y) => realised(policy, y, objectives) - realised(policy, x, objectives) || x.costUsd - y.costUsd,
      )[0];
      const strongest = [...row.actions].sort(
        (x, y) => y.tier - x.tier || y.costUsd - x.costUsd,
      )[0];
      const chosen = sel.selected;
      picks.push({
        row,
        chosen,
        policyResult: sel.policyResult,
        oracle,
        strongest,
        regret: chosen
          ? realised(policy, oracle, objectives) - realised(policy, chosen.truth, objectives)
          : null,
      });
      if (cut == null) history.push(...outcomeRows(row, a));
    }
    results[policy] = summarize(picks, { seed, resamples });
  }
  return {
    matrix: true,
    rows: rows.length,
    evaluation: cut != null ? 'holdout' : 'prequential',
    holdoutBefore: holdoutBefore ?? null,
    trainRows: cut != null ? train.length : null,
    testRows: test.length,
    undatedExcluded: undated,
    policies: results,
    note: 'Leitura offline da matriz fornecida; nenhum modelo foi chamado. O roteador vê só linhas anteriores ao ponto avaliado.',
  };
}

function bootstrap(deltas, seed, resamples) {
  if (!deltas.length) return null;
  let state = seed >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const samples = [];
  for (let i = 0; i < resamples; i++)
    samples.push(mean(Array.from({ length: deltas.length }, () => deltas[Math.floor(random() * deltas.length)])));
  samples.sort((a, b) => a - b);
  return [samples[Math.floor(samples.length * 0.025)], samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.975))]];
}

function metrics(picks) {
  const routed = picks.filter((p) => p.chosen);
  const truth = routed.map((p) => p.chosen.truth);
  const successes = truth.filter((t) => t.success).length;
  const cost = sum(truth.map((t) => t.costUsd));
  const lat = truth.map((t) => t.latencyMs).filter(finite);
  const oracleTruth = picks.map((p) => p.oracle);
  const strongest = picks.map((p) => p.strongest);
  const brier = routed.length
    ? mean(routed.map((p) => (p.chosen.pSuccess - (p.chosen.truth.success ? 1 : 0)) ** 2))
    : null;
  return {
    n: picks.length,
    routed: routed.length,
    floorUnmet: picks.length - routed.length,
    successRate: routed.length ? successes / routed.length : null,
    totalCostUsd: cost,
    meanCostUsd: routed.length ? cost / routed.length : null,
    costPerSuccessUsd: successes ? cost / successes : null,
    latencyP50Ms: lat.length ? quantile(lat, 0.5) : null,
    latencyP95Ms: lat.length ? quantile(lat, 0.95) : null,
    meanRegret: mean(routed.map((p) => p.regret)),
    oracleAgreement: routed.length
      ? routed.filter((p) => p.chosen.modelId === p.oracle.model && p.chosen.effort === p.oracle.effort).length / routed.length
      : null,
    oracleSuccessRate: picks.length ? oracleTruth.filter((t) => t.success).length / picks.length : null,
    oracleCostUsd: sum(oracleTruth.map((t) => t.costUsd)),
    strongestSuccessRate: picks.length ? strongest.filter((t) => t.success).length / picks.length : null,
    strongestCostUsd: sum(strongest.map((t) => t.costUsd)),
    brier,
  };
}

function summarize(picks, { seed, resamples }) {
  const routed = picks.filter((p) => p.chosen);
  const calibration = calibrationReport(
    routed.map((p) => ({ p: p.chosen.pSuccess, success: p.chosen.truth.success })),
    { minSamples: 1 },
  );
  const strata = {};
  const add = (key, p) => (strata[key] ??= []).push(p);
  for (const p of picks) {
    const a = p.row.assessment;
    add(`difficulty:${a.difficulty}`, p);
    add(`risk:${a.risks.length ? 'hard' : 'none'}`, p);
    add(`kind:${kindOf(a.features.intents)}`, p);
  }
  const count = (xs) => xs.reduce((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});
  return {
    ...metrics(picks),
    savingsVsStrongestUsd: sum(picks.map((p) => p.strongest.costUsd)) - sum(routed.map((p) => p.chosen.truth.costUsd)),
    savingsConfidenceInterval: bootstrap(
      routed.map((p) => p.strongest.costUsd - p.chosen.truth.costUsd),
      seed,
      resamples,
    ),
    ece: calibration.ece,
    calibrationBins: calibration.bins,
    policyResults: count(picks.map((p) => p.policyResult)),
    effortDistribution: count(routed.map((p) => p.chosen.effort)),
    modelDistribution: count(routed.map((p) => p.chosen.modelId)),
    costSources: count(routed.map((p) => p.chosen.costSource)),
    strata: Object.fromEntries(
      Object.entries(strata)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, ps]) => {
          const m = metrics(ps);
          return [k, { n: m.n, successRate: m.successRate, meanCostUsd: m.meanCostUsd, meanRegret: m.meanRegret, oracleAgreement: m.oracleAgreement }];
        }),
    ),
  };
}

// Reproducible paired replay. Input provenance/evidence must be reviewed by the operator.
export function benchmark(records, { seed = 12345, resamples = 1000 } = {}) {
  if (
    !Array.isArray(records) ||
    records.length > 10000 ||
    !Number.isInteger(resamples) ||
    resamples < 100 ||
    resamples > 10000
  )
    throw Error('Invalid benchmark records/budget');
  const paired = records.filter(
    (r) =>
      Number.isFinite(r.observedCost) &&
      r.observedCost >= 0 &&
      Number.isFinite(r.baselineCost) &&
      r.baselineCost >= 0,
  );
  const accepted = paired.filter((r) => r.verifiedAccepted === true),
    baselineAccepted = paired.filter((r) => r.baselineVerifiedAccepted === true);
  if (!paired.length)
    return {
      tasks: records.length,
      pairedAccepted: 0,
      costPerAcceptedTask: null,
      baselineCostPerAcceptedTask: null,
      savingsConfidenceInterval: null,
      measuredCoverage: 0,
    };
  let state = seed >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const sum = (xs) => xs.reduce((a, b) => a + b, 0),
    mean = (xs) => sum(xs) / xs.length;
  const deltas = paired.map((r) => r.baselineCost - r.observedCost),
    samples = [];
  for (let i = 0; i < resamples; i++)
    samples.push(
      mean(
        Array.from({ length: paired.length }, () => deltas[Math.floor(random() * paired.length)]),
      ),
    );
  samples.sort((a, b) => a - b);
  return {
    tasks: records.length,
    pairedAccepted: accepted.length,
    pairedMeasured: paired.length,
    costPerAcceptedTask: accepted.length
      ? sum(paired.map((r) => r.observedCost)) / accepted.length
      : null,
    baselineCostPerAcceptedTask: baselineAccepted.length
      ? sum(paired.map((r) => r.baselineCost)) / baselineAccepted.length
      : null,
    baselineAcceptanceCoverage:
      paired.filter((r) => typeof r.baselineVerifiedAccepted === 'boolean').length / paired.length,
    meanSavingsUSD: mean(deltas),
    savingsConfidenceInterval: [
      samples[Math.floor(samples.length * 0.025)],
      samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.975))],
    ],
    measuredCoverage: paired.length / records.length,
    seed,
    resamples,
  };
}
