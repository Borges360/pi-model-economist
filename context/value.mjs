import { contextValue, tokenIncrement } from '../economics/operations.mjs';
import { retrievalVoi, retrieve } from './retrieval.mjs';
/** Built-in VOI policy; external adapters can refine it but are never required. */
export async function economicRetrieval(store, query, { model, prediction, failureCostUsd, cache, history = [], ...options } = {}) {
  const ranked = await retrieve(store, query, options), items = [], considered = [];
  for (const item of ranked.items) {
    const own = history.filter(r => r.handle === item.handle && r.verified === true && Number.isFinite(r.successGain));
    const calibratedGain = own.length >= 30 ? own.reduce((n, r) => n + r.successGain, 0) / own.length : null;
    const economics = contextValue({ prediction, failureCostUsd, tokenCostUsd: tokenIncrement(model, item.tokens, cache), relevance: item.score, calibratedGain });
    const voi = retrievalVoi(economics, options.epsilon);
    considered.push({ handle: item.handle, economics, voi });
    if (voi.retrieve) items.push({ ...item, economics, voi });
  }
  return { items, tokens: items.reduce((n, i) => n + i.tokens, 0), considered,
    reason: items.length ? 'positive-context-voi' : considered.some(i => i.voi.reason === 'voi-unknown') ? 'voi-unknown' : 'insufficient-voi' };
}

/** Optional, deterministic local vector features. No remote embedder or downloaded model. */
export function localEmbedding(text, { dimensions = 256 } = {}) {
  const result = Array(dimensions).fill(0);
  for (const term of String(text).toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []) {
    const word = term.replace(/(?:ing|ed|es|s)$/, ''); let code = 2166136261;
    for (const char of word) code = Math.imul(code ^ char.codePointAt(0), 16777619) >>> 0;
    result[code % dimensions] += 1;
  }
  const norm = Math.hypot(...result);
  return norm ? result.map(n => n / norm) : result;
}
