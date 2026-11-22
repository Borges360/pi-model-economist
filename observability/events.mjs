import { uid } from '../lib/core.mjs';
export const EVENT_KINDS = ['route.considered', 'route.selected', 'cache.observed', 'cache.invalidated', 'context.retrieved', 'context.externalized',
  'compaction.started', 'compaction.completed', 'compaction.validated', 'delegate.started', 'delegate.completed', 'outcome.verified', 'rollout.changed'];
// A numeric/enum whitelist keeps content out even if a caller passes an entire host event.
const FIELDS = new Set(['routeId', 'taskFamily', 'model', 'effort', 'contextTokens', 'cacheReadTokens', 'cacheWriteTokens', 'uncachedInputTokens',
  'inputTokens', 'hitRatio', 'cacheKeyHash', 'costUsd', 'estimatedCostUsd', 'success', 'provenance', 'source', 'stage', 'reason', 'handle',
  'retainedTokens', 'externalizedTokens', 'retrievedTokens', 'utilizedTokens', 'fidelity', 'ratio', 'durationMs', 'ttftMs', 'status', 'count', 'score', 'propensity']);
export function economicsEvent(kind, payload = {}, scope = {}) {
  if (!EVENT_KINDS.includes(kind)) throw Error('Unknown economics event');
  const safe = {};
  for (const [key, value] of Object.entries(payload)) if (FIELDS.has(key) && (value === null || typeof value === 'boolean' ||
    typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length < 200 && !/[\r\n]/.test(value))) safe[key] = value;
  return { eventVersion: 2, id: uid(), kind: `economist.${kind}`, occurredAt: new Date().toISOString(),
    projectId: scope.projectId, sessionId: scope.sessionId, taskId: scope.taskId, payload: safe };
}
