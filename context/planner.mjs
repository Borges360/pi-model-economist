import { compactionPolicy } from './compaction.mjs';
import { topologyPlan } from '../topology/delegate.mjs';
/** Hierarchical planning keeps the public model/effort action space unchanged. */
export function planContext({ context, refs = [], retrieval = [], task = {}, economics = {}, turnsSinceCompact = Infinity }, config = {}, capabilities = {}) {
  const compact = compactionPolicy({ contextTokens: context.tokens, contextWindow: context.window, unusedRatio: context.unusedRatio,
    nextStepTokens: economics.nextStepTokens, keepCostUsd: economics.keepCostUsd, compactCostUsd: economics.compactCostUsd,
    informationLossUsd: economics.informationLossUsd, degradation: context.degradation, turnsSinceCompact }, config.context?.compaction);
  const topology = topologyPlan(task, { ...config.topology, available: capabilities.isolatedWorker === 'available' });
  return { retain: refs.filter(r => r.class === 'invariant' || r.class === 'decision'), retrieve: retrieval.map(r => r.handle),
    externalize: refs.filter(r => r.class === 'evidence').map(r => r.handle), compact, topology,
    overheadUsd: { retrieval: economics.retrievalApiUsd ?? 0, compaction: compact.compact ? economics.compactionApiUsd ?? 0 : 0,
      handoff: topology.topology === 'isolated-worker' ? economics.handoffUsd ?? null : 0,
      refetch: economics.refetchUsd ?? 0, rework: economics.reworkUsd ?? 0 },
    economics, provenance: 'estimated' };
}
