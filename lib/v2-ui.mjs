export const v2Copy = locale => locale === 'pt-BR' ? {
  mode: 'Prioridade', control: 'Controle', context: 'Contexto', metrics: 'Economia da sessão', advanced: 'Avançado', privacy: 'Privacidade',
  modeDescription: 'Escolha Economy, Balanced, Quality, Adaptive ou Custom. Ctrl+S salva o preset.',
  controlDescription: 'Automatic, confirmação antes de mudanças estruturais ou somente recomendações.',
  contextDescription: 'Artefatos recuperáveis, orçamento de retrieval e checkpoints estruturados.',
  metricsDescription: 'Custo, cache, contexto, fidelidade e capacidades disponíveis. Desconhecido não é zero.',
  advancedDescription: 'Classificador, cadência, esforço, privacidade, rollout e política de aprendizado.',
  unknown: 'indisponível', observed: 'observado', measured: 'observado', derived: 'derivado', estimated: 'estimado',
} : {
  mode: 'Priority', control: 'Control', context: 'Context', metrics: 'Session economics', advanced: 'Advanced', privacy: 'Privacy',
  modeDescription: 'Choose Economy, Balanced, Quality, Adaptive or Custom. Ctrl+S saves the preset.',
  controlDescription: 'Automatic, ask before structural changes, or advisory only.',
  contextDescription: 'Recoverable artifacts, retrieval budgets and structured checkpoints.',
  metricsDescription: 'Cost, cache, context, fidelity and available capabilities. Unknown is not zero.',
  advancedDescription: 'Classifier, cadence, effort, privacy, rollout and learning policy.',
  unknown: 'unknown', observed: 'observed', measured: 'observed', derived: 'derived', estimated: 'estimated',
};
export function economicsLines(report, capabilities = {}, locale = 'en', rollout = {}) {
  const t = v2Copy(locale), num = n => Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : t.unknown;
  const money = m => m?.value != null ? `$${m.value.toFixed(6)} (${t[m.provenance] ?? m.provenance})` : t.unknown;
  const pct = n => Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : t.unknown;
  const lines = [
    `Actual / estimated: ${money(report.actualCostUsd)} / ${money(report.estimatedCostUsd)}`,
    `CPVS: ${report.cpvs == null ? t.unknown : `$${report.cpvs.toFixed(6)} (${report.cpvsProvenance})`} · verified ${report.verifiedSuccesses}`,
    `Context: ${num(report.context.tokens)} / ${num(report.context.window)} (${report.context.provenance})`,
    `Cache: ${pct(report.cacheHitRate)} · reads ${num(report.cacheReadTokens)} · writes ${num(report.cacheWriteTokens)}`,
    `Cached token fraction: ${pct(report.cachedTokenFraction)} · observed calls ${num(report.cacheHitSamples)} · unknown calls ${num(report.cacheUnknownSamples)}`,
    `Cache savings: ${money(report.cacheSavingsUsd)}`,
    `Retrieval: ${report.retrievedTokens} tokens · context yield ${pct(report.contextYield)}`,
    `Compaction: ${report.compactions} · fidelity ${pct(report.compactionFidelity)} · ratio ${num(report.compactionRatio)}`,
    `Latency p50/p95: ${num(report.latencyMs.p50)} / ${num(report.latencyMs.p95)} ms`,
    `TTFT p50/p95: ${num(report.ttftMs.p50)} / ${num(report.ttftMs.p95)} ms`,
    `Workers: ${report.delegations} · success ${pct(report.delegationSuccess)}`,
    `Brier / ECE: ${num(report.brier)} / ${num(report.ece)} · fallback ${pct(report.fallbackRate)}`,
    `Quality / safety floor violations: ${num(report.qualityFloorViolations)} / ${num(report.safetyFloorViolations)}`,
    `Retrieval precision / recall: ${pct(report.retrievalPrecision)} / ${pct(report.retrievalRecall)}`,
    `Delegation rework: ${num(report.delegationReworkCost)} USD · post-compaction failure ${pct(report.postCompactionFailureRate)}`,
    `Cost error: ${num(report.costErrorPct)}%`,
    ...Object.entries(report.operations ?? {}).map(([category, value]) => `${category}: ${value.count} · API ${num(value.apiUsd)} USD · input attribution ${num(value.attributedInputUsd)} USD · local ${num(value.localDurationMs)} ms`),
    `Rollout: ${rollout.stage ?? 'observe'}${rollout.rollback ? ` · rollback ${rollout.rollback.join(', ')}` : ''}`,
    ...Object.entries(capabilities).map(([key, value]) => `${key}: ${value}`),
  ];
  if (locale !== 'pt-BR') return lines;
  const labels = [['Actual / estimated', 'Real / estimado'], ['verified', 'verificados'], ['Context:', 'Contexto:'], ['reads', 'leituras'], ['writes', 'escritas'],
    ['Cache savings', 'Economia de cache'], ['context yield', 'utilidade do contexto'], ['Compaction:', 'Compactação:'], ['fidelity', 'fidelidade'],
    ['Latency', 'Latência'], ['Workers', 'Trabalhadores'], ['success', 'sucesso'], ['fallback', 'fallback'], ['Quality / safety floor violations', 'Violações de pisos de qualidade / segurança'],
    ['Retrieval precision / recall', 'Precisão / recall de retrieval'], ['Delegation rework', 'Retrabalho de delegação'], ['post-compaction failure', 'falha após compactação'],
    ['Cost error', 'Erro de custo'], ['input attribution', 'atribuição ao input'], ['Cached token fraction', 'Fração de tokens em cache'],
    ['observed calls', 'chamadas observadas'], ['unknown calls', 'chamadas sem medição']];
  return lines.map(line => labels.reduce((text, [from, to]) => text.replaceAll(from, to), line));
}

export function economicsHeader(report, locale = 'en') {
  const unknown = v2Copy(locale).unknown, pct = n => Number.isFinite(n) ? `${Math.round(n * 100)}%` : unknown;
  const cost = report.actualCostUsd.value ?? report.estimatedCostUsd.value;
  const label = report.actualCostUsd.value == null ? locale === 'pt-BR' ? 'derivado' : 'derived' : locale === 'pt-BR' ? 'observado' : 'observed';
  return [
    `CPVS ${report.cpvs == null ? unknown : `$${report.cpvs.toFixed(5)}`} · ${locale === 'pt-BR' ? 'Sessão' : 'Session'} ${cost == null ? unknown : `$${cost.toFixed(4)} ${label}`}`,
    `${locale === 'pt-BR' ? 'Contexto' : 'Context'} ${report.context.tokens ?? '?'} / ${report.context.window ?? '?'} · Cache ${pct(report.cacheHitRate)}`,
    `Retrieval ${report.retrievedTokens} · ${locale === 'pt-BR' ? 'Compactações' : 'Compactions'} ${report.compactions} · ${locale === 'pt-BR' ? 'Fidelidade' : 'Fidelity'} ${pct(report.compactionFidelity)}`,
  ].join('\n');
}

export function causalExplain(decision, locale = 'en') {
  const pt = locale === 'pt-BR', unknown = v2Copy(locale).unknown, money = value => Number.isFinite(value) ? `$${value.toFixed(6)}` : unknown;
  const selected = decision.switchPlan, breakdown = selected?.breakdown;
  return [
    `${pt ? 'Causas da decisão' : 'Decision causes'}:`,
    `  ✓ quality floor: ${decision.pSuccess} ≥ ${decision.qualityFloor}`,
    `  ${decision.pSafe == null ? '?' : '✓'} safety floor: ${decision.pSafe ?? unknown}`,
    `  cache: ${decision.cacheImpact?.reason ?? unknown} · ${pt ? 'confiança' : 'confidence'} ${decision.cacheImpact?.confidence ?? unknown}`,
    `  ${pt ? 'Topologia' : 'Topology'}: ${decision.contextPlan?.topology.topology ?? 'single-agent'}`,
    ...(breakdown ? [
      `  ${pt ? 'Manter / trocar' : 'Stay / switch'}: ${selected.currentModel} → ${selected.candidateModel}`,
      `    API ${money(breakdown.currentRequestUsd)} → ${money(breakdown.candidateRequestUsd)}`,
      `    ${pt ? 'Recuperação esperada' : 'Expected recovery'} ${money(breakdown.currentRecoveryUsd)} → ${money(breakdown.candidateRecoveryUsd)}`,
      `    cache ${money(breakdown.currentCacheDiscountUsd)} → ${money(breakdown.candidateCacheDiscountUsd)} (${pt ? 'incluído no input' : 'included in input'})`,
      `    ${pt ? 'Ganho líquido' : 'Net gain'} ${money(selected.deltaUsd)} · premium ${money(selected.premiumUsd)}`,
      `  ${pt ? 'Decisão' : 'Decision'}: ${selected.reason}`,
    ] : []),
    ...Object.entries(decision.costBreakdown ?? {}).map(([key, value]) => `  ${key}: ${typeof value === 'number' ? money(value) : value}`),
  ];
}
