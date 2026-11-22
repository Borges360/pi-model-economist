import { calibrationReport, quantile } from '../decision.mjs';
const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const probability = n => valid(n) && n <= 1;
export const ACCEPTANCE_GATE_VERSION = 3;
function rng(seed) { let state = seed >>> 0; return () => ((state = (Math.imul(1664525, state) + 1013904223) >>> 0) / 4294967296); }
export function verifiedMetrics(rows = []) {
  const verified = rows.filter(r => typeof r.success === 'boolean' && r.verified === true);
  const success = verified.filter(r => r.success).length;
  const costKnown = verified.length > 0 && verified.every(r => valid(r.costUsd));
  const cost = costKnown ? verified.reduce((n, r) => n + r.costUsd, 0) : null;
  const predictions = verified.filter(r => probability(r.prediction));
  const predictionsComplete = verified.length > 0 && predictions.length === verified.length;
  const cal = calibrationReport(predictions.map(r => ({ p: r.prediction, success: r.success })));
  const total = field => verified.length && verified.every(r => valid(r[field])) ? verified.reduce((n, r) => n + r[field], 0) : null;
  const average = field => { const n = total(field); return n == null ? null : n / verified.length; };
  const percentile = (field, p) => verified.length && verified.every(r => valid(r[field])) ? quantile(verified.map(r => r[field]), p) : null;
  const afterCompact = verified.filter(r => r.postCompaction === true);
  const bulky = verified.filter(r => r.bulkOutput === true);
  const relevant = total('relevantRetrievedCount'), retrieved = total('retrievedCount'), required = total('requiredRelevantCount');
  const errors = verified.filter(r => valid(r.actualCostUsd) && valid(r.estimatedCostUsd)).map(r => r.actualCostUsd === 0
    ? r.estimatedCostUsd === 0 ? 0 : null : Math.abs(r.estimatedCostUsd - r.actualCostUsd) / r.actualCostUsd);
  return { n: verified.length, verifiedSuccesses: success, successRate: verified.length ? success / verified.length : null,
    costUsd: cost, cpvs: costKnown && success ? cost / success : null,
    brier: predictionsComplete ? predictions.reduce((n, r) => n + (r.prediction - Number(r.success)) ** 2, 0) / predictions.length : null,
    ece: predictionsComplete ? cal.ece ?? null : null,
    latencyP50Ms: percentile('latencyMs', 0.5), latencyP95Ms: percentile('latencyMs', 0.95),
    safetyEvents: verified.filter(r => r.safetyEvent === true).length, qualityFloorViolations: verified.filter(r => r.qualityFloorViolation === true).length,
    safetyFloorViolations: verified.filter(r => r.safetyFloorViolation === true).length,
    inputTokens: total('inputTokens'), uncachedInputTokens: total('uncachedInputTokens'), cacheReadTokens: total('cacheReadTokens'), cacheWriteTokens: total('cacheWriteTokens'),
    bulkyUncachedInputTokens: bulky.length && bulky.every(r => valid(r.uncachedInputTokens)) ? bulky.reduce((n, r) => n + r.uncachedInputTokens, 0) : null,
    costErrorMean: verified.length && errors.length === verified.length && errors.every(valid) ? errors.reduce((n, r) => n + r, 0) / errors.length : null,
    compactionFidelity: average('compactionFidelity'), constraintRecall: average('constraintRecall'),
    retrievalPrecision: retrieved > 0 && relevant != null ? relevant / retrieved : null,
    retrievalRecall: required > 0 && relevant != null ? relevant / required : null,
    postCompactionSuccessRate: afterCompact.length ? afterCompact.filter(r => r.success).length / afterCompact.length : null,
    modelSwitches: total('modelSwitches'), switchCacheMisses: total('switchCacheMisses'), reworkTurns: total('reworkTurns'),
    ttftP50Ms: percentile('ttftMs', 0.5), ttftP95Ms: percentile('ttftMs', 0.95) };
}

const CONTROLS = ['model', 'version', 'provider', 'commit', 'toolsHash', 'timeoutMs', 'verifier'];
export const ARMS = ['v0.4', 'context', 'cache', 'routing', 'context+cache', 'full-adaptive'];
/** Paired measured replay only; incompatible experiments and missing outcomes are never imputed. */
export function evaluateAblations(rows, { seed = 12345, resamples = 1000, minSamples = 30 } = {}) {
  if (!Array.isArray(rows) || rows.length > 10000 || !Number.isInteger(resamples) || resamples < 100 || resamples > 10000 ||
    !Number.isInteger(minSamples) || minSamples < 1 || !Number.isInteger(seed)) throw Error('Invalid ablation matrix');
  minSamples = Math.max(30, minSamples);
  const groups = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !ARMS.includes(row.arm) || typeof row.taskId !== 'string' || !row.taskId.trim() ||
      !(typeof row.seed === 'string' && row.seed.length > 0 || Number.isInteger(row.seed)) ||
      !CONTROLS.every(k => k === 'timeoutMs' ? valid(row[k]) && row[k] > 0 : typeof row[k] === 'string' && row[k].trim())) throw Error('Ablation row missing experimental controls');
    const numericFields = ['costUsd', 'actualCostUsd', 'estimatedCostUsd', 'inputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens',
      'latencyMs', 'ttftMs', 'retrievedCount', 'relevantRetrievedCount', 'requiredRelevantCount', 'switchCacheMisses', 'modelSwitches', 'reworkTurns'];
    if (numericFields.some(k => row[k] != null && !valid(row[k])) ||
      ['prediction', 'constraintRecall', 'compactionFidelity'].some(k => row[k] != null && !probability(row[k])) ||
      valid(row.relevantRetrievedCount) && (valid(row.retrievedCount) && row.relevantRetrievedCount > row.retrievedCount ||
        valid(row.requiredRelevantCount) && row.relevantRetrievedCount > row.requiredRelevantCount)) throw Error('Invalid ablation matrix');
    const key = JSON.stringify([row.taskId, row.seed, ...CONTROLS.map(k => row[k])]);
    const group = groups.get(key) ?? new Map();
    if (group.has(row.arm)) throw Error('Duplicate task/seed/arm');
    group.set(row.arm, row); groups.set(key, group);
  }
  const arms = {};
  for (const arm of ARMS.slice(1)) {
    const matched = [...groups.values()].filter(g => g.has('v0.4') && g.has(arm)).map(g => [g.get('v0.4'), g.get(arm)]);
    const pairs = matched
      .filter(p => p.every(r => r.verified === true && typeof r.success === 'boolean' && valid(r.costUsd)));
    const tasks = new Map();
    for (const pair of pairs) { const key = String(pair[0].taskId); (tasks.get(key) ?? (tasks.set(key, []), tasks.get(key))).push(pair); }
    const clusters = [...tasks.values()];
    const baseline = verifiedMetrics(pairs.map(p => p[0])), treatment = verifiedMetrics(pairs.map(p => p[1]));
    const random = rng(seed), deltas = [], qualityDeltas = []; let wins = 0, validResamples = 0;
    for (let b = 0; pairs.length && b < resamples; b++) {
      const sample = Array.from({ length: clusters.length }, () => clusters[Math.floor(random() * clusters.length)]).flat();
      const a = verifiedMetrics(sample.map(p => p[0])), c = verifiedMetrics(sample.map(p => p[1]));
      qualityDeltas.push(a.successRate - c.successRate);
      if (a.cpvs != null && c.cpvs != null) { const delta = a.cpvs - c.cpvs; deltas.push(delta); wins += delta > 0 ? 1 : 0; validResamples++; }
    }
    const probability = validResamples ? wins / validResamples : null;
    const qualityDeltaCi95 = [quantile(qualityDeltas, 0.025), quantile(qualityDeltas, 0.975)];
    const floorEvidence = pairs.length > 0 && pairs.every(pair => pair[1].qualityFloorSatisfied === true && pair[1].safetyFloorSatisfied === true);
    const qualityPreserved = treatment.successRate != null && qualityDeltaCi95[1] <= 0.01 && floorEvidence &&
      treatment.safetyEvents === 0 && treatment.qualityFloorViolations === 0 && treatment.safetyFloorViolations === 0;
    const calibrated = treatment.ece != null && treatment.ece <= 0.08 && treatment.brier != null && baseline.brier != null && treatment.brier <= baseline.brier + 0.01;
    const latencyPreserved = treatment.latencyP95Ms != null && baseline.latencyP95Ms != null && treatment.latencyP95Ms <= baseline.latencyP95Ms * 1.15;
    const reduction = (before, after) => before > 0 && valid(after) ? (before - after) / before : null;
    const cpvsReduction = reduction(baseline.cpvs, treatment.cpvs);
    const inputReduction = reduction(baseline.bulkyUncachedInputTokens, treatment.bulkyUncachedInputTokens);
    const switchMissReduction = reduction(baseline.switchCacheMisses, treatment.switchCacheMisses);
    const measuredEvidence = pairs.length > 0 && pairs.every(pair => pair.every(r => r.provenance === 'measured'));
    const acceptance = {
      measuredEvidence, enoughPairs: pairs.length >= minSamples && tasks.size >= minSamples,
      completePairs: pairs.length > 0 && pairs.length === matched.length &&
        [...groups.values()].every(g => !g.has('v0.4') && !g.has(arm) || g.has('v0.4') && g.has(arm)),
      ablationCoverage: arm !== 'full-adaptive' || groups.size > 0 && [...groups.values()].every(g => ARMS.every(a => {
        const row = g.get(a);
        return row?.verified === true && row.provenance === 'measured' && typeof row.success === 'boolean' && valid(row.costUsd);
      })),
      costError: treatment.costErrorMean != null && treatment.costErrorMean < 0.10,
      floors: floorEvidence && treatment.qualityFloorViolations === 0 && treatment.safetyFloorViolations === 0 && treatment.safetyEvents === 0,
      constraints: treatment.constraintRecall != null && treatment.constraintRecall >= 0.95,
      uncachedInput: inputReduction != null && inputReduction >= 0.20,
      quality: qualityPreserved, cpvs: cpvsReduction != null && cpvsReduction >= 0.15,
      latency: latencyPreserved, calibration: calibrated,
      switching: switchMissReduction != null && switchMissReduction >= 0.30,
      retrieval: treatment.retrievalPrecision != null && treatment.retrievalPrecision >= 0.70,
      compaction: treatment.compactionFidelity != null && treatment.compactionFidelity >= 0.95 && treatment.postCompactionSuccessRate != null &&
        baseline.postCompactionSuccessRate != null && baseline.postCompactionSuccessRate - treatment.postCompactionSuccessRate <= 0.02,
      improvementProbability: probability > 0.95,
    };
    const strata = {};
    for (const pair of pairs) for (const [key, value] of Object.entries(pair[1].strata ?? {})) {
      const label = `${key}:${value}`; (strata[label] ??= []).push(pair[1]);
    }
    arms[arm] = { pairedN: pairs.length, matchedN: matched.length, excludedPairs: matched.length - pairs.length,
      unmatchedBaseline: [...groups.values()].filter(g => g.has('v0.4') && !g.has(arm)).length,
      unmatchedTreatment: [...groups.values()].filter(g => g.has(arm) && !g.has('v0.4')).length,
      independentTasks: tasks.size, bootstrapUnit: 'task-with-all-seeds', baseline, treatment, probabilityImprovement: probability,
      cpvsDeltaCi95: [quantile(deltas, 0.025), quantile(deltas, 0.975)],
      qualityPreserved, qualityDeltaCi95, floorEvidence, calibrated, latencyPreserved,
      acceptance, missingOrFailed: Object.entries(acceptance).filter(([, ok]) => !ok).map(([key]) => key), cpvsReduction, inputReduction, switchMissReduction,
      eligible: Object.values(acceptance).every(Boolean),
      strata: Object.fromEntries(Object.entries(strata).map(([k, rs]) => [k, verifiedMetrics(rs)])) };
  }
  return { evaluationVersion: 2, gateVersion: ACCEPTANCE_GATE_VERSION, seed, resamples, minSamples, arms };
}

/** IPS/SNIPS with overlap and effective sample size. No unchosen outcomes invented. */
export function offPolicy(rows, targetProbability) {
  let weighted = 0, weights = 0, squares = 0, n = 0, unsupported = 0;
  for (const row of rows) {
    if (row.verified !== true || typeof row.success !== 'boolean') continue;
    const target = targetProbability(row);
    if (!valid(target) || target > 1 || !valid(row.propensity) || row.propensity <= 0 || row.propensity > 1) { unsupported++; continue; }
    const w = target / row.propensity;
    weighted += w * Number(row.success); weights += w; squares += w * w; n++;
  }
  return { n, unsupported, ips: n ? weighted / n : null, snips: weights ? weighted / weights : null,
    effectiveSampleSize: squares ? weights * weights / squares : 0,
    limitation: 'Only logged action support is identifiable; deterministic logs cannot evaluate unseen actions.' };
}
