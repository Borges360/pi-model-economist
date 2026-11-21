import { hash } from '../lib/core.mjs';
const finite = Number.isFinite;
/** Hysteresis runs only over the already feasible set. Hard-risk/retry checkpoints bypass it. */
export function switchDecision(actions, selected, { currentId, turnsSinceSwitch = Infinity, hardRisk = false, config = {}, preferred = false } = {}) {
  const current = actions.find(a => a.id === currentId);
  if (!current || current.id === selected.id || hardRisk || preferred) return { selected, reason: !current ? 'current-infeasible' : hardRisk ? 'safety-checkpoint' : preferred ? 'explicit-preference' : 'same-action', deltaUsd: null };
  if (current.modelId === selected.modelId) return { selected, reason: 'same-cache-model', deltaUsd: 0 };
  if (![current.policyCostUsd, selected.policyCostUsd].every(finite)) return { selected: current, reason: 'switch-cost-unknown', deltaUsd: null };
  const deltaUsd = current.policyCostUsd - selected.policyCostUsd;
  const premium = (config.riskPremiumUsd ?? 0) + (config.uncertaintyPremiumUsd ?? 0);
  const gainPct = current.policyCostUsd > 0 ? deltaUsd / current.policyCostUsd * 100 : 0;
  const stay = turnsSinceSwitch < (config.minTurnsBetweenSwitches ?? 2) || gainPct <= (config.minExpectedGainPct ?? 12) || deltaUsd <= premium;
  return { selected: stay ? current : selected, reason: stay ? 'cache-hysteresis' : 'economic-switch', deltaUsd, gainPct, premiumUsd: premium,
    requestDeltaUsd: finite(current.baseCostUsd) && finite(selected.baseCostUsd) ? current.baseCostUsd - selected.baseCostUsd : null,
    currentModel: current.modelId, candidateModel: selected.modelId,
    breakdown: { currentRequestUsd: current.baseCostUsd, candidateRequestUsd: selected.baseCostUsd,
      currentRecoveryUsd: current.expectedRecoveryCostUsd ?? null, candidateRecoveryUsd: selected.expectedRecoveryCostUsd ?? null,
      currentCacheDiscountUsd: current.expectedCacheSavingsUsd ?? null, candidateCacheDiscountUsd: selected.expectedCacheSavingsUsd ?? null,
      cacheRewarmAccounting: 'already-in-request-input', riskAndUncertaintyPremiumUsd: premium },
    confidence: current.cacheForecast?.prediction?.confidence ?? 'unknown' };
}

export function contextualBandit(actions, greedy, outcomes = [], { family, kappa = 0.15, minSamples = 30, hardRisk = false, maxPremium = 0.1, failureCostUsd = 1 } = {}) {
  const feasible = actions.filter(a => a.pSuccess >= greedy.qualityFloor && (a.pSafe == null || a.pSafe >= (greedy.safetyThreshold ?? 0.9)));
  const pool = feasible.length ? feasible : [greedy];
  if (hardRisk) return { choice: greedy, shadowChoice: greedy.id, eligible: false, propensity: 1, reason: 'hard-risk' };
  const scored = pool.filter(a => finite(a.policyCostUsd) && a.policyCostUsd <= greedy.policyCostUsd * (1 + maxPremium)).map(a => {
    const own = outcomes.filter(o => o.verified === true && o.family === family && o.model === a.modelId && o.effort === a.effort && typeof o.success === 'boolean');
    const n = own.length, p = (own.filter(o => o.success).length + 1) / (n + 2);
    const sigma = Math.sqrt(p * (1 - p) / (n + 3));
    return { action: a, n, score: failureCostUsd * (n ? p : a.pSuccess) - a.policyCostUsd + kappa * sigma,
      informationValue: failureCostUsd * sigma, premium: Math.max(0, a.policyCostUsd - greedy.policyCostUsd) };
  }).filter(a => a.informationValue > a.premium).sort((a, b) => b.score - a.score || a.action.id.localeCompare(b.action.id));
  const top = scored[0];
  return { choice: top?.action ?? greedy, shadowChoice: top?.action.id ?? greedy.id,
    eligible: Boolean(top && top.n >= minSamples), samples: top?.n ?? 0, propensity: 1,
    reason: top?.n >= minSamples ? 'calibrated-family' : 'insufficient-family-samples' };
}

export function costCascade(actions, { floor, safetyThreshold = 0.9, failedIds = [] } = {}) {
  return actions.filter(a => a.pSuccess >= floor && (a.pSafe == null || a.pSafe >= safetyThreshold) && !failedIds.includes(a.id) && finite(a.policyCostUsd))
    .sort((a, b) => a.policyCostUsd - b.policyCostUsd || b.pSuccess - a.pSuccess)[0] ?? null;
}

export function rolloutAllowed(stage, key, { approved = true, rollback = false } = {}) {
  if (!approved || rollback || ['observe', 'shadow'].includes(stage)) return false;
  if (stage === 'active') return true;
  const percent = stage === 'canary-5' ? 5 : stage === 'canary-25' ? 25 : 0;
  return parseInt(hash(key).slice(0, 8), 16) % 100 < percent;
}

export function rollbackReasons(current, baseline, config = {}) {
  const reasons = [];
  if (current.safetyEvents > 0 || current.safetyFloorViolations > 0 || current.qualityFloorViolations > 0) reasons.push('floor-or-safety-event');
  if (finite(current.compactionFidelity) && current.compactionFidelity < 0.95) reasons.push('compaction-fidelity');
  if (baseline && current.n >= 30 && baseline.n >= 30) {
    if (baseline.successRate - current.successRate > (config.maxQualityRegression ?? 0.01)) reasons.push('quality-regression');
    if (finite(current.cpvs) && finite(baseline.cpvs) && current.cpvs > baseline.cpvs * (1 + (config.maxCostRegression ?? 0.15))) reasons.push('cost-regression');
    if (finite(current.ece) && finite(baseline.ece) && current.ece - baseline.ece > (config.maxEceRegression ?? 0.01)) reasons.push('ece-regression');
  }
  return reasons;
}
