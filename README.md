# Pi Model Economist

Routes eligible Pi requests to a physical model-and-effort pair using configured capability, risk, quality, cost and latency signals. It does not call a model to simulate or replay a benchmark.

**Manifest:** `pi-model-economist` · **version:** `2.0.0` · **private:** `true`
**Registry status:** not verified; this checkout does not establish an npm release.
**Runtime:** Node.js `>=22.19.0`; Pi `1.5.2–1.6.x`. The loader/TUI smoke targets the newest installed Pi release (verified with `1.6.0`), with synthetic metadata and no provider calls.

Version 2.0 adds context planning, recoverable tool artifacts, economic retrieval, incremental structured compaction, measured cache usage and unified cost accounting around the existing ranker. Open `/economist` and choose a preset and control level; advanced settings expose rollout, retrieval, cache-aware switching, cascades, bandit shadow and native Pi workers. Legacy policies map to the corresponding preset (Latency to Custom), retaining advisory/observe control and independent settings without writes. New sessions start at Balanced/advisory/observe. Adaptive activation requires paired measured evidence; no real-world savings are claimed from offline tests. See [the 2.0 architecture and integration guide](docs/v2.md).

Commands added in 2.0: `/economist preset economy|balanced|quality|adaptive|custom`, `/economist control automatic|ask|advisory`, `/economist rollout observe|shadow|canary-5|canary-25|active`, `/economist metrics`, `/economist capabilities`, `/economist migrate --preview|--write`, `/economist evaluate FILE.jsonl` and `/economist off-policy FILE.jsonl`. `economist_retrieve` indexes permitted files and recovers artifacts. The opt-in `economist_delegate` uses a separate real Pi Agent with file permissions, token/cost/turn budgets, cancellation and lead review. Its bounded tools provide context isolation, not an OS sandbox. The original `economist_subagent_model` tool remains advice-only.

## English

### What it does

The extension evaluates a task and lets the Pi host dispatch the selected model. Its ranking unit is `(model, effort)`. Rules and optional classifiers assess a request; policies choose among actions that meet quality, capability, risk and budget constraints. `/economist explain` reports the last decision. The `economist_subagent_model` tool returns model-and-effort advice to an integrating parent and does not change that parent or call a model.

The extension does not guarantee model competence, measured savings or provider availability. Price, quality and latency depend on configured metadata and verified local history. Unpriced cache, time-to-first-token or reasoning terms are not invented.

### Install and run

The manifest marks this package `private: true`. No public npm installation command or registry listing is claimed. For a source checkout whose Pi peer packages are already available, load the extension with:

```sh
pi -e ./index.ts
```

Run its local unit suite from the repository with `npm test`. The package preview in this change is a local `npm pack --dry-run`; it does not publish or install a release.

### Commands

The root command opens the settings panel:

```text
/economist
```

The panel lists every setting with its current value: language, routing on/off, priority preset, control, context, retrieval budget, privacy, cadence, assessment, policy, effort, pool source, rollout, algorithm, learning and delegation. Opening it reads nothing from disk or network beyond the current configuration.

| Key | In the panel |
| --- | --- |
| ↑ / ↓ | Move between rows (the host's own select keys). |
| Enter | Open a choice list, toggle an on/off row, or open a row's screen. |
| Ctrl+S | Save the draft; the panel stays open and confirms where it saved. A failed save keeps the draft. |
| Esc | Leave a choice list without applying it; on a draft, warn first and discard on the second Esc; during a save or an operation, cancel it. |
| Tab · / | Reach the Save/Help/Close bar · search rows. |

Choosing a priority preset shows its consequences (policy, cadence, effort, context, rollout) in the draft before you save; an explicit edit made after the preset wins. The rows *Candidate pool*, *Session economics*, *Last decision*, *Simulate a request* and *Command-line reference* open their own screen; Esc returns to the panel. The pool and the simulation ask for a saved draft first, because they work on the saved settings; the read-only screens keep your draft.

Useful actions include:

| Command | Purpose |
| --- | --- |
| `/economist setup` | Propose a candidate pool from the current scoped/authenticated model metadata and ask before setup writes. |
| `/economist on` / `/economist off` | Enable or disable automatic routing. |
| `/economist cadence` | Choose `session`, `prompt` or `subagent` re-evaluation. |
| `/economist mode` | Choose `off`, `manual`, `rules`, `jev`, `small-llm`, `hybrid` or `learned` assessment. |
| `/economist policy` | Choose `economy`, `balanced`, `quality` or `latency` ranking. |
| `/economist role list` / `/economist role <role> model <provider/model\|clear>` | Set a preferred approved model for Planner, Executor or Reviewer calls. |
| `/economist role <role> effort <level\|auto>` | Prefer a thinking effort for that role while global thinking is `auto`; `auto` clears the preference. |
| `/economist role <role> fallback on\|off` | Explicitly allow or refuse another approved candidate when the role preference is infeasible. |
| `/economist candidates list\|add\|remove` | Inspect or edit the candidate pool. |
| `/economist thinking auto\|follow\|fixed` | Select how thinking-effort actions are formed. |
| `/economist budget task\|session\|project` | Configure routing budget limits. |
| `/economist simulate "task"` | Run a synthetic, free decision simulation. |
| `/economist benchmark --dataset <file.jsonl>` | Replay an existing measured matrix offline; it does not call a model. |
| `/economist explain`, `/economist json` | Inspect the latest decision in human-readable or structured form. |

Other configuration actions include `mode`, `policy`, `classifier`, `classifier-model`, `scope` and `thinking`. Native Pi argument completion describes valid values. See [the decision flow](docs/fluxo-de-decisao.md) for selection, retries, safety and benchmark details.

The primary intent maps `design`, `search`, `read` and `explain` to Planner; `test` to Reviewer; and other intents to Executor. A role preference only reorders feasible actions inside the existing candidate pool. Fallback is off by default, and an infeasible preference stops routing with an explicit recovery message. Updating a preference affects a later route and does not call `setModel` or change an in-flight request.

### Configuration and state

The extension reads and writes only its `modelEconomist` configuration section. A trusted project can use `.pi/pi-suite.yaml`; the global file is `${PI_SUITE_HOME:-~/.pi/agent/pi-suite}/config.yaml`. Defaults are overridden by global values, project values and then a locked global policy. The `/economist` panel defaults to English and offers English or Brazilian Portuguese. The locale is read and saved only as `modelEconomist.locale` in the current trusted project's `.pi/pi-suite.yaml`; it is never inherited from global configuration. Changing language previews the panel immediately; Ctrl+S saves the draft, while Esc warns before discarding it. In an untrusted project the language row is shown as locked and nothing is written.

Decision history and measured inputs use local JSON/JSONL storage scoped by the canonical Git root. There is no database. The `yaml` dependency parses configuration.

### Language

The panel is localized in English and Brazilian Portuguese, including its keys, hints and messages. English is the default and fallback for missing or invalid project locale values. Menu copy previews immediately and remains a draft until Ctrl+S; failed saves keep the draft open. Language preference belongs to the current trusted project and does not leak between projects or sessions.

### Privacy and security

`dataPolicy` configures handling for the classifier, executor and telemetry separately. Raw system prompts, tool stdout and image bytes are not written to the route log or sent by this extension's classifier path. A live routing decision may be dispatched by Pi to the provider selected in the host; this package does not replace provider authentication or consent. `simulate` and benchmark replay make no model/provider call. Tests use doubles and synthetic data; they do not demonstrate paid or external-provider behavior.

### Troubleshooting and limits

- Use `/economist explain` to inspect the last decision and its available evidence.
- Use `/economist candidates list` to check the configured pool and scope.
- Missing model capability, authentication, health, context, price or budget can make an action infeasible; follow the recovery command in the error instead of relaxing safety limits.
- `pSuccess` uses verified outcomes and priors. `pSafe` remains unknown until the required risk samples exist. Estimated cost is not an invoice or a savings measurement.
- The real Pi loader/TUI smoke (`npm run test:host`) renders the panel at 40/80/120 columns with synthetic model metadata; provider integrations, a physical terminal (resizing, fonts) and human review are separate validation.

### License

The product manifest does not declare a software license, and no product license is asserted here. Third-party code under `vendor/` keeps its own license and provenance; see [vendor/THIRD_PARTY_NOTICES.md](vendor/THIRD_PARTY_NOTICES.md).

## Português (Brasil)

### O que faz

A extensão avalia a tarefa e permite que o host Pi despache o modelo escolhido. A unidade do ranking é o par `(modelo, esforço)`. Regras e classificadores opcionais avaliam o pedido; políticas selecionam entre ações que atendem aos limites de qualidade, capacidade, risco e orçamento. `/economist explain` mostra a última decisão. A ferramenta `economist_subagent_model` devolve uma sugestão de modelo e esforço a um integrador de subagentes; não altera o agente pai nem chama um modelo.

A extensão não garante competência do modelo, economia medida ou disponibilidade do provedor. Preço, qualidade e latência dependem dos metadados configurados e do histórico local verificado. Termos sem preço — cache, tempo até o primeiro token ou raciocínio — não são inventados.

### Instalação e execução

O manifesto marca o pacote como `private: true`. Não há afirmação de instalação pública pelo npm nem de publicação no registry. Em um checkout cujos pacotes peer do Pi já estejam disponíveis, carregue a extensão com:

```sh
pi -e ./index.ts
```

Execute a suíte local com `npm test` na raiz do repositório. A prévia deste pacote usa `npm pack --dry-run`; ela não publica nem instala uma versão.

### Comandos

O comando raiz abre o painel de configurações:

```text
/economist
```

O painel lista cada configuração com o valor atual: idioma, roteamento ligado/desligado, preset de prioridade, controle, contexto, orçamento de retrieval, privacidade, cadência, avaliação, política, esforço, fonte do pool, rollout, algoritmo, aprendizado e delegação. Abrir o painel não lê disco nem rede além da configuração atual.

| Tecla | No painel |
| --- | --- |
| ↑ / ↓ | Move entre as linhas (as teclas de seleção do próprio host). |
| Enter | Abre a lista de opções, alterna uma linha ligado/desligado ou abre a tela da linha. |
| Ctrl+S | Salva o rascunho; o painel continua aberto e confirma onde salvou. Uma falha mantém o rascunho. |
| Esc | Sai da lista sem aplicar; com rascunho, avisa e descarta no segundo Esc; durante um salvamento ou operação, cancela. |
| Tab · / | Chega à barra Salvar/Ajuda/Fechar · busca linhas. |

Escolher um preset de prioridade mostra as consequências (política, cadência, esforço, contexto, rollout) no rascunho antes de salvar; uma edição explícita feita depois do preset prevalece. As linhas *Pool de candidatos*, *Economia da sessão*, *Última decisão*, *Simular um pedido* e *Referência de comandos* abrem a própria tela; Esc volta ao painel. O pool e a simulação pedem o rascunho salvo antes, porque trabalham com a configuração salva; as telas somente leitura preservam o rascunho.

| Comando | Finalidade |
| --- | --- |
| `/economist setup` | Propõe candidatos a partir dos metadados de modelos atuais e pede confirmação antes de gravar. |
| `/economist on` / `/economist off` | Ativa ou desativa o roteamento automático. |
| `/economist cadence` | Escolhe reavaliação por `session`, `prompt` ou `subagent`. |
| `/economist mode` | Escolhe avaliação `off`, `manual`, `rules`, `jev`, `small-llm`, `hybrid` ou `learned`. |
| `/economist policy` | Escolhe ranking `economy`, `balanced`, `quality` ou `latency`. |
| `/economist role list` / `/economist role <papel> model <provider/model\|clear>` | Define um modelo aprovado preferido para Planejador, Executor ou Revisor. |
| `/economist role <papel> effort <nível\|auto>` | Prefere um esforço nesse papel quando o modo global está em `auto`; `auto` limpa a preferência. |
| `/economist role <papel> fallback on\|off` | Permite ou recusa explicitamente outra ação aprovada quando a preferência não atende aos limites. |
| `/economist candidates list\|add\|remove` | Consulta ou altera o conjunto de candidatos. |
| `/economist thinking auto\|follow\|fixed` | Define como são formadas as ações de esforço de raciocínio. |
| `/economist budget task\|session\|project` | Configura limites de orçamento do roteamento. |
| `/economist simulate "tarefa"` | Executa uma simulação sintética e gratuita. |
| `/economist benchmark --dataset <arquivo.jsonl>` | Reproduz offline uma matriz medida existente; não chama um modelo. |
| `/economist explain`, `/economist json` | Consulta a última decisão em formato legível ou estruturado. |

Também há configurações para `mode`, `policy`, `classifier`, `classifier-model` e `scope`. O autocomplete nativo do Pi mostra os valores disponíveis. Veja o [fluxo de decisão](docs/fluxo-de-decisao.md) para ranking, retries, segurança e benchmark.

A intenção principal mapeia `design`, `search`, `read` e `explain` para Planejador; `test` para Revisor; e as demais intenções para Executor. A preferência só reordena ações viáveis dentro do conjunto de candidatos existente. O fallback fica desligado por padrão; uma preferência inviável interrompe o roteamento com uma orientação explícita. Salvar a preferência vale para uma rota futura e não chama `setModel` nem altera uma chamada em andamento.

### Configuração e estado

A extensão lê e grava somente a seção `modelEconomist`. Um projeto confiável pode usar `.pi/pi-suite.yaml`; o arquivo global fica em `${PI_SUITE_HOME:-~/.pi/agent/pi-suite}/config.yaml`. Defaults recebem overrides global, de projeto e, por último, uma política global bloqueada. O painel `/economist` abre em inglês e oferece inglês ou português brasileiro. O idioma é lido e salvo somente como `modelEconomist.locale` no `.pi/pi-suite.yaml` do projeto confiável atual; ele nunca vem da configuração global. A troca pré-visualiza o painel imediatamente; Ctrl+S salva o rascunho e Esc avisa antes de descartá-lo. Em um projeto não confiável a linha de idioma aparece bloqueada e nada é gravado.

Histórico de decisões e entradas medidas ficam em JSON/JSONL local, isolado pela raiz Git canônica. Não há banco de dados. A dependência `yaml` lê a configuração.

### Idioma

O painel tem textos em inglês e português brasileiro, inclusive teclas, dicas e mensagens. Inglês é o padrão e o fallback para idioma de projeto ausente ou inválido. A prévia do menu é imediata e fica em rascunho até Ctrl+S; uma falha ao salvar mantém o rascunho aberto. A preferência pertence ao projeto confiável atual e não vaza entre projetos ou sessões.

### Privacidade e segurança

`dataPolicy` configura separadamente o tratamento para classificador, executor e telemetria. Prompts de sistema brutos, saída de ferramentas e bytes de imagem não são gravados no log de roteamento nem enviados pelo caminho de classificação desta extensão. Uma decisão de roteamento ao vivo pode ser despachada pelo Pi ao provedor selecionado no host; o pacote não substitui autenticação ou consentimento do provedor. `simulate` e replay de benchmark não chamam modelos ou provedores. Os testes usam doubles e dados sintéticos; não comprovam comportamento pago ou de provedor externo.

### Diagnóstico e limites

- Use `/economist explain` para examinar a decisão e as evidências disponíveis.
- Use `/economist candidates list` para conferir pool e escopo.
- Falta de capacidade, autenticação, saúde, janela de contexto, preço ou orçamento pode tornar uma ação inviável; siga a recuperação indicada em vez de relaxar limites de segurança.
- `pSuccess` usa resultados verificados e priors. `pSafe` permanece desconhecido até existir a amostra de risco exigida. Custo estimado não é fatura nem medição de economia.
- O smoke do carregador e do painel reais (`npm run test:host`) renderiza o painel em 40/80/120 colunas, com metadados sintéticos; provedores reais, um terminal físico (redimensionamento, fontes) e a revisão humana exigem validação própria.

### Licença

O manifesto não declara licença de software para o produto; este README não afirma uma. O código de terceiros em `vendor/` mantém licença e procedência próprias; veja [vendor/THIRD_PARTY_NOTICES.md](vendor/THIRD_PARTY_NOTICES.md).
