import { tokens } from './artifacts.mjs';
import { timed } from '../lib/core.mjs';
const terms = text => new Set(String(text).toLowerCase().match(/[\p{L}\p{N}_$]{3,}/gu) ?? []);
const cosine = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length || ![...a, ...b].every(Number.isFinite)) return 0;
  const norm = Math.hypot(...a) * Math.hypot(...b);
  return norm ? a.reduce((s, v, i) => s + v * b[i], 0) / norm : 0;
};
export function retrievalVoi({ successGain = null, failureCost = null, retrieveCost = null, tokenCost = null }, epsilon = 0.1) {
  const valid = [successGain, failureCost, retrieveCost, tokenCost].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  if (!valid) return { retrieve: false, ratio: null, reason: 'voi-unknown' };
  const gain = successGain * failureCost, cost = retrieveCost + tokenCost;
  const ratio = cost === 0 ? gain > 0 ? Infinity : 0 : gain / cost;
  return { retrieve: ratio > 1 + epsilon, ratio: Number.isFinite(ratio) ? ratio : null, reason: gain > cost * (1 + epsilon) ? 'positive-voi' : 'insufficient-voi' };
}

/** Lexical -> symbols/graph -> recency -> optional local embeddings -> deterministic rerank. */
export async function retrieve(store, query, { budgetTokens = 2048, minScore = 0.12, now = Date.now(), symbols = [], embed = null, signal, economics = null, epsilon = 0.1 } = {}) {
  signal?.throwIfAborted();
  const q = terms(query);
  if (!q.size) return { items: [], tokens: 0, reason: 'no-query-evidence' };
  if (economics && !retrievalVoi(economics, epsilon).retrieve) return { items: [], tokens: 0, reason: retrievalVoi(economics, epsilon).reason };
  const candidates = [];
  const refs = await store.list();
  const anchors = refs.filter(ref => (ref.symbols ?? []).some(s => q.has(s.toLowerCase())));
  const graphSymbols = new Set(anchors.flatMap(ref => ref.references ?? []).map(s => s.toLowerCase()));
  for (const ref of refs) {
    signal?.throwIfAborted();
    const snippet = await store.get(ref.handle, { budgetTokens: Math.min(32768, budgetTokens), signal });
    const words = terms(snippet.text);
    const lexical = [...q].filter(t => words.has(t)).length / q.size;
    const symbol = [...q, ...symbols].some(t => (ref.symbols ?? []).some(s => s.toLowerCase() === t.toLowerCase())) ? 1 : 0;
    const graph = (ref.symbols ?? []).some(s => graphSymbols.has(s.toLowerCase())) ? 1 : 0;
    const recency = Math.exp(-Math.max(0, now - Date.parse(ref.createdAt)) / 86400000);
    // Recency alone must never manufacture relevance.
    if (!lexical && !symbol && !graph) continue;
    let semantic = 0;
    if (embed) semantic = Math.max(0, cosine(await timed(s => embed(query, { signal: s }), 2500, signal), await timed(s => embed(snippet.text, { signal: s }), 2500, signal)));
    const score = 0.55 * lexical + 0.2 * symbol + 0.1 * graph + 0.1 * recency + 0.05 * semantic - 0.05 * snippet.tokens / budgetTokens;
    if (score >= minScore) candidates.push({ ...ref, score, text: snippet.text, tokens: snippet.tokens });
  }
  candidates.sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle));
  const items = []; let used = 0;
  for (const item of candidates) {
    const remaining = budgetTokens - used;
    if (remaining < 32) break;
    const text = item.text.slice(0, remaining * 4);
    items.push({ ...item, text, tokens: tokens(text) }); used += tokens(text);
  }
  return { items, tokens: used, reason: items.length ? 'relevant-within-budget' : 'abstained' };
}
