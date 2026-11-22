import { privateText, tokens } from './artifacts.mjs';
import { hash } from '../lib/core.mjs';
const textOf = m => typeof m.content === 'string' ? m.content : (m.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const unique = items => [...new Set(items)];
const empty = () => ({ checkpointVersion: 2, objective: '', constraints: [], decisions: [], artifacts: [], changed_files: [],
  tests: { passed: [], failed: [] }, open_questions: [], risks: [], next_actions: [], retrieval_handles: [] });

export function structuredCheckpoint(messages = [], { previous = null, fileOps = {}, handles = [], customInstructions = '', factCache = null } = {}) {
  if (factCache) {
    const combined = structuredCheckpoint([], { previous });
    for (const message of messages) {
      const key = hash(message);
      let fact = factCache.get(key);
      if (!fact) {
        fact = structuredCheckpoint([message]);
        if (JSON.stringify(fact).length <= 32768) {
          if (factCache.size >= 256) factCache.delete(factCache.keys().next().value);
          factCache.set(key, fact);
        }
      }
      if (!combined.objective) combined.objective = fact.objective;
      for (const name of ['constraints', 'decisions', 'artifacts', 'changed_files', 'open_questions', 'risks', 'next_actions', 'retrieval_handles']) combined[name].push(...fact[name]);
      for (const status of ['passed', 'failed']) combined.tests[status].push(...fact.tests[status]);
    }
    return structuredCheckpoint([], { previous: combined, fileOps, handles, customInstructions });
  }
  let prior = empty();
  if (previous) {
    try { const parsed = typeof previous === 'string' ? JSON.parse(previous) : previous;
      const arrays = ['constraints', 'decisions', 'artifacts', 'changed_files', 'open_questions', 'risks', 'next_actions', 'retrieval_handles'];
      if (parsed.checkpointVersion === 2 && arrays.every(k => Array.isArray(parsed[k])) && Array.isArray(parsed.tests?.passed) && Array.isArray(parsed.tests?.failed)) prior = parsed;
      else prior.constraints.push(privateText(typeof previous === 'string' ? previous : JSON.stringify(previous))); }
    catch { prior.constraints.push(privateText(previous)); }
  }
  const result = { ...empty(), ...structuredClone(prior) };
  for (const message of messages) {
    const text = privateText(textOf(message));
    if (message.role === 'user' && text.trim() && message.economistEvidence !== true && !text.startsWith('[Economist retrieved evidence;')) {
      if (!result.objective) result.objective = text;
      // Human constraints/acceptance criteria are kept verbatim, rather than regex guesses.
      result.constraints.push(text);
    }
    if (message.role === 'assistant') {
      for (const line of text.split('\n').filter(l => /^(?:decision|decisão|rationale|justificativa|risk|risco|next|próxim|open question|question|pergunta|dúvida)/i.test(l.trim()))) {
        if (/^(?:risk|risco)/i.test(line)) result.risks.push(line);
        else if (/^(?:open question|question|pergunta|dúvida)/i.test(line)) result.open_questions.push(line);
        else if (/^(?:next|próxim)/i.test(line)) result.next_actions.push(line);
        else result.decisions.push({ id: `d-${hash(line).slice(0, 12)}`, statement: line, rationale: 'assistant-reported; requires verification', confidence: 'unknown' });
      }
      for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === 'toolCall' && ['edit', 'write'].includes(block.name)) {
        const path = block.arguments?.path ?? block.arguments?.file_path;
        if (typeof path === 'string') result.changed_files.push(privateText(path));
      }
    }
    if (message.role === 'toolResult') {
      const code = message.details?.exitCode ?? message.details?.exit_code;
      const command = message.details?.command;
      if (Number.isInteger(code) && typeof command === 'string' && /\b(test|pytest|tsc|typecheck|jest|vitest)\b/.test(command))
        result.tests[code === 0 ? 'passed' : 'failed'].push(privateText(command));
    }
  }
  if (customInstructions) result.constraints.push(privateText(customInstructions));
  const modified = fileOps.edited ?? fileOps.modifiedFiles ?? [];
  result.changed_files.push(...Array.from(modified).filter(v => typeof v === 'string').map(privateText));
  const read = fileOps.read ?? fileOps.readFiles ?? [];
  result.artifacts.push(...Array.from(read).filter(v => typeof v === 'string').map(path => ({ path: privateText(path), role: 'read' })));
  result.retrieval_handles = unique([...result.retrieval_handles, ...handles]);
  for (const key of ['constraints', 'changed_files', 'open_questions', 'risks', 'next_actions']) result[key] = unique(result[key]);
  result.decisions = [...new Map(result.decisions.map(d => [d.statement, d])).values()];
  result.artifacts = [...new Map(result.artifacts.map(a => [a.path, a])).values()];
  result.tests = { passed: unique(result.tests.passed), failed: unique(result.tests.failed) };
  return result;
}

export function checkpointFidelity(expected, actual) {
  const recall = (a, b) => !a.length ? 1 : a.filter(x => b.includes(x)).length / a.length;
  const fields = { constraints: recall(expected.constraints, actual.constraints),
    decisions: recall(expected.decisions.map(d => JSON.stringify(d)), actual.decisions.map(d => JSON.stringify(d))),
    artifacts: recall([...expected.changed_files, ...expected.retrieval_handles, ...expected.artifacts.map(a => a.path)],
      [...actual.changed_files, ...actual.retrieval_handles, ...actual.artifacts.map(a => a.path)]),
    tests: recall([...expected.tests.passed, ...expected.tests.failed], [...actual.tests.passed, ...actual.tests.failed]) };
  return { ...fields, fidelity: 0.35 * fields.constraints + 0.25 * fields.decisions + 0.2 * fields.artifacts + 0.2 * fields.tests,
    hallucinationRate: actual.constraints.filter(c => !expected.constraints.includes(c)).length / Math.max(1, actual.constraints.length), weights: 'assumed-v1' };
}

export function compactionPolicy({ contextTokens, contextWindow, unusedRatio = null, nextStepTokens = 2048, degradation = null,
  keepCostUsd = null, compactCostUsd = null, informationLossUsd = null, turnsSinceCompact = Infinity }, config = {}) {
  const occupancy = contextWindow > 0 && contextTokens != null ? contextTokens / contextWindow : null;
  const overflowRisk = occupancy == null ? null : Math.max(0, Math.min(1, (contextTokens + nextStepTokens) / contextWindow));
  const pressureWeight = 0.6 + 0.15 + (unusedRatio == null ? 0 : 0.2) + (degradation == null ? 0 : 0.05);
  const pressure = occupancy == null ? null : (0.6 * occupancy + 0.2 * (unusedRatio ?? 0) + 0.15 * overflowRisk + 0.05 * (degradation ?? 0)) / pressureWeight;
  const economic = [keepCostUsd, compactCostUsd, informationLossUsd].every(v => typeof v === 'number' && Number.isFinite(v));
  const emergency = overflowRisk !== null && overflowRisk > 0.95;
  const compact = config.enabled !== false && turnsSinceCompact >= (config.minTurns ?? 3) &&
    (emergency || pressure > (config.threshold ?? 0.72) && economic && keepCostUsd > compactCostUsd + informationLossUsd);
  return { compact, pressure, overflowRisk, occupancy, provenance: 'estimated',
    reason: compact ? emergency ? 'overflow-risk' : 'economic-benefit' : economic ? 'retain' : 'cost-unknown' };
}

export function prepareStructuredCompaction(preparation, options = {}) {
  const checkpoint = structuredCheckpoint([...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])],
    { ...options, previous: preparation.previousSummary, fileOps: preparation.fileOps });
  const summary = JSON.stringify(checkpoint);
  if (tokens(summary) > (options.maxCheckpointTokens ?? 8192)) return { checkpoint, compaction: null, reason: 'invariants-exceed-budget' };
  // Evidence cannot disappear: an externalized episode is required for opaque assistant/tool text.
  if (!options.episodeHandle && (preparation.messagesToSummarize ?? []).some(m => m.role !== 'user'))
    return { checkpoint, compaction: null, reason: 'episode-not-recoverable' };
  return { checkpoint, compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore,
    estimatedTokensAfter: tokens(summary), details: { economistVersion: 2, checkpoint, readFiles: checkpoint.artifacts.map(a => a.path), modifiedFiles: checkpoint.changed_files } } };
}
