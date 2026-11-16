# Changelog

## 0.4.0

A unidade de ranking passa a ser a ação `(modelo, esforço)`. `route()`, `assess()`, os filtros de capacidade, o fallback do classificador, o orçamento, o circuito, a fase fast, os gates verificados e o log `model-routes` continuam; o ranking e as políticas foram para `decision.mjs`.

### Fase 1 — políticas e retry

- Quatro políticas com quantidades separadas: `predictedCostUsd` (só dinheiro), latência p50/p95 e `pSuccess`.
- `objectives.latencyValueUsdPerSecond` (0,01) substitui `latencyWeight`. `estimatedTotalCostUsd` passa a ser só dinheiro.
- Piso de qualidade por dificuldade (0,45 / 0,55 / 0,70 / 0,80 / 0,88) e `qualityFloorOverride` em `decide()` e `simulate --floor`.
- `balanced` usa q*, `successTie` 0,02, `softBudgetUsd` e `targetLatencyMs`. Relaxamento: latência, depois orçamento suave; piso e segurança nunca relaxam. Log `policyResult`.
- `jev` e `small-llm` classificam todo pedido elegível; `hybrid` e `learned` só via `shouldClassify`.
- `validateFeasibility` antes de reaproveitar qualquer par; em `manual`/`off`, par inviável gera erro com o comando de conserto.
- Retry por causa: rede, servidor (`provider-fallback`), contexto (`model.context_overflow`, sugestão de `/compact`), capacidade, política e escada de qualidade.

### Fase 2 — ações, estado e privacidade

- `auto` enumera uma ação por nível suportado; `follow`, `fixed` e ás de escopo geram uma.
- `pSuccess` de partida por tier (0,62 / 0,74 / 0,84 / 0,88 / 0,91, teto 0,97). `pSafe` nulo abaixo de 20 amostras (guardrail de raciocínio) e ≥ `safetyThreshold` 0,90 acima.
- `RoutingFeatures` multi-rótulo, chave de família `${kind}|risk:${impact}|tools:..|image:..`, perfil de raciocínio por modelo.
- `buildRoutingState` e checkpoints `plan`, `tool_failure`, `before_edit`, `test_rejected`, `recovery`.
- `dataPolicy` para classificador, executor e telemetria; `redact()` cobre e-mail e telefone; `scrubEntropy()`.
- Jev e small-LLM recebem `intents`, `riskImpact` e `reversibility`.
- Envelope de subagente (`degraded-subagent-context` quando ausente).
- Texto normalizado; risco determinístico, semântico, de contexto e de legenda.
- Imagem: `image-uninspected` sem descritor; legenda (`caption`) com descritor injetado.
- Fast path por `pSuccess` + margem 0,05; `fast-path-not-worth-classifier`.

### Fase 3 — aprendizado verificado

- Beta (α 1, β 3, meia-vida 30 dias) só com fontes verificadas: gate, test, typecheck, exit_code, ci, file_diff e judge confiável. Esforços dominados marcados.
- `expectedRetries`; custo de recuperação pela próxima ação da escada (`recoverySource`).
- Preço de cache, TTFT e raciocínio com `reasoning-price-shared`, `cache-unpriced`, `ttft-unpriced`. Sem preço publicado, o termo é zero.
- Distribuição de tokens e `requiredWindow` (crescimento de ferramenta 2048, margem 512); `token-estimate-fallback`.
- Valor da informação (`minUtilityMargin` 0,05, `materialCostGap` 0,25), campos do classificador e ROI no log.
- Bins de calibração e ECE; `applyCalibration` desligado por padrão; `minCalibratedProbability` 0,6.

### Fase 4 — mistura e exploração

- Mistura ponderada: Beta próprio, pool por intenção (0,5), prior do tier (α+β), vizinhos do embedder (0,25, cosseno ≥ 0,85).
- Preferência Bradley-Terry (`learned.preference`, ≥ 20 pares).
- `learned.deployment` `shadow`/`active`, kappa 0,15, exploração uma vez por família por sessão, prêmio ≤ 10%. A regra "a cada 20 linhas" saiu.

### Fase 5 — benchmark e explain

- `benchmark --dataset` com matriz JSONL (até 1000 linhas): oráculo por política, regret, estratos, métricas, `--holdout-before`. Nunca chama modelo.
- `/economist explain` mostra pSuccess, pSafe, p50, p95, custo, cache, `finalOutcome`, ROI e calibração.

### Removido

`latencyWeight`, `cacheSwitchPenalty`, `minHistorySamples`, `explorationEvery`, `fastPath.eligibleDifficulties`, `fastPath.prohibitOnRisks`, `thinking.riskFloor`, `thinking.riskOverridesSelection` e `rank()`. Configurações com essas chaves continuam carregando; as chaves são ignoradas.

### Comportamento visível

- Sem histórico, `auto` tende ao menor esforço que atende o piso; risco duro sem amostras exige um nível que pensa.
- O pino de sessão cai com risco duro novo ou checkpoint.
- `503`, `429` e `overload` são `server`, não `network`.
