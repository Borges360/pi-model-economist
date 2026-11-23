# Pi Model Economist

Routes each eligible Pi request to a model-and-effort pair that meets your capability, risk, quality, cost and latency limits.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Validate](https://github.com/Borges360/pi-model-economist/actions/workflows/test.yml/badge.svg)](https://github.com/Borges360/pi-model-economist/actions/workflows/test.yml)

**English** · [Português (Brasil)](#português-brasil)

| | |
| --- | --- |
| Package | `pi-model-economist` · `2.0.0` · private, not published to npm |
| Status | Development release. Routing and the panel are covered by unit tests and a real Pi loader smoke; savings have not been measured in real use. |
| Compatibility | Node.js `>=22.19.0`; Pi `1.5.2`–`1.6.x` (peer range `>=1.5.2 <1.7.0`); loader and panel smoke verified with Pi `1.6.0`. |

## English

### What it does

The extension evaluates a task and lets the Pi host dispatch the selected model. Its ranking unit is `(model, effort)`. Rules and optional classifiers assess a request; policies choose among actions that meet quality, capability, risk and budget constraints. `/economist explain` reports the last decision. The `economist_subagent_model` tool returns model-and-effort advice to an integrating parent; it does not change that parent or call a model. Routing does not call a model to simulate or replay a benchmark.

The extension does not guarantee model competence, measured savings or provider availability. Price, quality and latency depend on configured metadata and verified local history. Unpriced cache, time-to-first-token or reasoning terms are not invented.

#### What's new in 2.0

Version 2.0 adds, around the existing ranker:

- context planning and recoverable tool artifacts;
- economic retrieval through the `economist_retrieve` tool, which indexes permitted files and recovers artifacts;
- incremental structured compaction;
- measured cache usage and unified cost accounting;
- an opt-in `economist_delegate` tool that runs a separate real Pi Agent with file permissions, token/cost/turn budgets, cancellation and lead review. Its bounded tools isolate context; they are not an OS sandbox.

Open `/economist` and choose a preset and a control level. Advanced settings expose rollout, retrieval, cache-aware switching, cascades, bandit shadow and native Pi workers. New sessions start at Balanced, advisory control and the `observe` rollout. Legacy policies map to the matching preset (Latency maps to Custom) and keep advisory/observe control and their independent settings, without writing to the configuration. `/economist migrate --preview` shows the mapping; `--write` saves it. The original `economist_subagent_model` tool remains advice-only.

> Adaptive activation requires paired measured evidence. No real-world savings are claimed from offline tests.

See [the 2.0 architecture and integration guide](docs/v2.md).

### Install

From a source checkout:

```sh
npm ci --ignore-scripts --legacy-peer-deps
pi -e ./index.ts
```

The manifest declares `pi.extensions`, so Pi can also install it from Git:

```sh
pi install git:github.com/Borges360/pi-model-economist
```

This installs from Git, not from the npm registry. The package is marked `private: true` and has no npm release. `npm pack --dry-run` previews the package contents locally; it does not publish or install anything.

### Use

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

Choosing a priority preset shows its consequences (policy, cadence, effort, context, rollout) in the draft before you save; an explicit edit made after the preset wins. The rows *Candidate pool*, *Session economics*, *Last decision*, *Simulate a request* and *Command-line reference* open their own screen; Esc returns to the panel. The pool and the simulation ask you to save the draft first, because they work on the saved settings; the read-only screens keep your draft.

| Command | Purpose |
| --- | --- |
| `/economist setup` | Propose a candidate pool from the current scoped/authenticated model metadata and ask before setup writes. |
| `/economist on` / `/economist off` | Enable or disable automatic routing. |
| `/economist preset economy\|balanced\|quality\|adaptive\|custom` | Choose an optimization preset. |
| `/economist control automatic\|ask\|advisory` | Choose the automation control level. |
| `/economist rollout observe\|shadow\|canary-5\|canary-25\|active` | Set the context-optimization rollout stage. |
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
| `/economist metrics` | Show context, cache and verified-success economics. |
| `/economist capabilities` | Show the observed host capabilities. |
| `/economist migrate --preview\|--write` | Preview the v2 mapping of a legacy configuration, or save it explicitly. |
| `/economist evaluate FILE.jsonl` | Run offline paired context/cache/routing ablations; no provider calls. |
| `/economist off-policy FILE.jsonl` | Compute offline IPS/SNIPS estimates from logged action probabilities. |
| `/economist explain`, `/economist json` | Inspect the latest decision in human-readable or structured form. |

Other configuration actions include `classifier`, `classifier-model` and `scope`. Native Pi argument completion describes valid values. See [the decision flow](docs/fluxo-de-decisao.md) for selection, retries, safety and benchmark details.

The primary intent maps `design`, `search`, `read` and `explain` to Planner; `test` to Reviewer; and other intents to Executor. A role preference only reorders feasible actions inside the existing candidate pool. Fallback is off by default, and an infeasible preference stops routing with an explicit recovery message. Updating a preference affects a later route; it does not call `setModel` or change an in-flight request.

### Configuration and state

The extension reads and writes only its `modelEconomist` configuration section. A trusted project can use `.pi/pi-suite.yaml`; the global file is `${PI_SUITE_HOME:-~/.pi/agent/pi-suite}/config.yaml`. Defaults are overridden by global values, then project values, then a locked global policy. A configuration example is in [examples/pi-suite.yaml](examples/pi-suite.yaml).

Decision history and measured inputs use local JSON/JSONL storage scoped by the canonical Git root. There is no database. The `yaml` dependency parses configuration.

### Language

The panel is localized in English and Brazilian Portuguese, including its keys, hints and messages. English is the default and the fallback for a missing or invalid project locale. The locale is read and saved only as `modelEconomist.locale` in the current trusted project's `.pi/pi-suite.yaml`; it is never inherited from global configuration, so it does not leak between projects or sessions.

Changing the language previews the panel immediately and stays a draft until Ctrl+S; Esc warns before discarding it, and a failed save keeps the draft open. In an untrusted project the language row is shown as locked and nothing is written.

### Privacy and security

`dataPolicy` configures handling for the classifier, executor and telemetry separately. Raw system prompts, tool stdout and image bytes are not written to the route log or sent by this extension's classifier path. A live routing decision may be dispatched by Pi to the provider selected in the host; this package does not replace provider authentication or consent. `simulate` and benchmark replay make no model or provider call. Tests use doubles and synthetic data; they do not demonstrate paid or external-provider behavior.

### Troubleshooting and limits

- Use `/economist explain` to inspect the last decision and its available evidence.
- Use `/economist candidates list` to check the configured pool and scope.
- Missing model capability, authentication, health, context, price or budget can make an action infeasible. Follow the recovery command in the error instead of relaxing safety limits.
- `pSuccess` uses verified outcomes and priors. `pSafe` stays unknown until the required risk samples exist. Estimated cost is not an invoice or a savings measurement.
- The real Pi loader and panel smoke (`npm run test:host`) renders the panel at 40/80/120 columns with synthetic model metadata. Provider integrations, a physical terminal (resizing, fonts) and human review need separate validation.

### Contributing

Set up the checkout and run the checks before opening a pull request:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm test
npm run test:host
```

`npm run test:host` needs an installed Pi 1.6; if it is not found, set `PI_CODING_AGENT_ENTRY` to the installed `pi-coding-agent` `dist` directory. Open pull requests against `develop`. See [CONTRIBUTING.md](CONTRIBUTING.md) and, for vulnerabilities, [SECURITY.md](SECURITY.md).

### License

MIT, see [LICENSE](LICENSE). Third-party code under `vendor/` keeps its own license and provenance; see [vendor/THIRD_PARTY_NOTICES.md](vendor/THIRD_PARTY_NOTICES.md).

## Português (Brasil)

### O que faz

A extensão avalia a tarefa e permite que o host Pi despache o modelo escolhido. A unidade do ranking é o par `(modelo, esforço)`. Regras e classificadores opcionais avaliam o pedido; políticas selecionam entre ações que atendem aos limites de qualidade, capacidade, risco e orçamento. `/economist explain` mostra a última decisão. A ferramenta `economist_subagent_model` devolve uma sugestão de modelo e esforço a um integrador de subagentes; não altera o agente pai nem chama um modelo. O roteamento não chama um modelo para simular ou reproduzir um benchmark.

A extensão não garante competência do modelo, economia medida ou disponibilidade do provedor. Preço, qualidade e latência dependem dos metadados configurados e do histórico local verificado. Termos sem preço (cache, tempo até o primeiro token ou raciocínio) não são inventados.

#### Novidades da 2.0

A versão 2.0 acrescenta, em torno do ranking existente:

- planejamento de contexto e artefatos de ferramenta recuperáveis;
- recuperação econômica pela ferramenta `economist_retrieve`, que indexa arquivos permitidos e recupera artefatos;
- compactação estruturada incremental;
- uso de cache medido e contabilidade de custo unificada;
- a ferramenta opcional `economist_delegate`, que executa um Pi Agent real e separado, com permissões de arquivo, orçamentos de tokens, custo e turnos, cancelamento e revisão pelo agente principal. Suas ferramentas limitadas isolam o contexto; não são um sandbox do sistema operacional.

Abra `/economist` e escolha um preset e um nível de controle. As configurações avançadas expõem rollout, recuperação, troca de modelo sensível ao cache, cascatas, bandit em shadow e workers nativos do Pi. Sessões novas começam em Balanced, controle advisory e rollout `observe`. Políticas antigas são mapeadas para o preset correspondente (Latency vira Custom) e mantêm o controle advisory/observe e suas configurações independentes, sem gravar na configuração. `/economist migrate --preview` mostra o mapeamento; `--write` o grava. A ferramenta original `economist_subagent_model` continua apenas sugerindo.

> A ativação adaptativa exige evidência medida pareada. Testes offline não comprovam economia no mundo real.

Veja o [guia de arquitetura e integração da 2.0](docs/v2.md).

### Instalação

A partir de um checkout do código:

```sh
npm ci --ignore-scripts --legacy-peer-deps
pi -e ./index.ts
```

O manifesto declara `pi.extensions`, então o Pi também pode instalar a extensão pelo Git:

```sh
pi install git:github.com/Borges360/pi-model-economist
```

Essa instalação vem do Git, não do registry do npm. O pacote está marcado como `private: true` e não tem versão publicada no npm. `npm pack --dry-run` mostra localmente o conteúdo do pacote; não publica nem instala nada.

### Uso

O comando raiz abre o painel de configurações:

```text
/economist
```

O painel lista cada configuração com o valor atual: idioma, roteamento ligado/desligado, preset de prioridade, controle, contexto, orçamento de recuperação, privacidade, cadência, avaliação, política, esforço, fonte do pool, rollout, algoritmo, aprendizado e delegação. Abrir o painel não lê disco nem rede além da configuração atual.

| Tecla | No painel |
| --- | --- |
| ↑ / ↓ | Move entre as linhas (as teclas de seleção do próprio host). |
| Enter | Abre a lista de opções, alterna uma linha ligado/desligado ou abre a tela da linha. |
| Ctrl+S | Salva o rascunho; o painel continua aberto e confirma onde salvou. Uma falha mantém o rascunho. |
| Esc | Sai da lista sem aplicar; com rascunho, avisa e descarta no segundo Esc; durante um salvamento ou operação, cancela. |
| Tab · / | Chega à barra Salvar/Ajuda/Fechar · busca linhas. |

Escolher um preset de prioridade mostra as consequências (política, cadência, esforço, contexto, rollout) no rascunho antes de salvar; uma edição explícita feita depois do preset prevalece. As linhas *Pool de candidatos*, *Economia da sessão*, *Última decisão*, *Simular um pedido* e *Referência de comandos* abrem a própria tela; Esc volta ao painel. O pool e a simulação pedem que você salve o rascunho antes, porque trabalham com a configuração salva; as telas somente leitura preservam o rascunho.

| Comando | Finalidade |
| --- | --- |
| `/economist setup` | Propõe candidatos a partir dos metadados de modelos atuais e pede confirmação antes de gravar. |
| `/economist on` / `/economist off` | Ativa ou desativa o roteamento automático. |
| `/economist preset economy\|balanced\|quality\|adaptive\|custom` | Escolhe um preset de otimização. |
| `/economist control automatic\|ask\|advisory` | Escolhe o nível de controle da automação. |
| `/economist rollout observe\|shadow\|canary-5\|canary-25\|active` | Define o estágio de rollout da otimização de contexto. |
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
| `/economist metrics` | Mostra a economia de contexto, cache e sucesso verificado. |
| `/economist capabilities` | Mostra as capacidades observadas do host. |
| `/economist migrate --preview\|--write` | Mostra o mapeamento v2 de uma configuração antiga ou o grava explicitamente. |
| `/economist evaluate ARQUIVO.jsonl` | Executa ablações offline pareadas de contexto, cache e roteamento; não chama provedores. |
| `/economist off-policy ARQUIVO.jsonl` | Calcula estimativas offline IPS/SNIPS a partir das probabilidades de ação registradas. |
| `/economist explain`, `/economist json` | Consulta a última decisão em formato legível ou estruturado. |

Também há configurações para `classifier`, `classifier-model` e `scope`. O autocomplete nativo do Pi mostra os valores disponíveis. Veja o [fluxo de decisão](docs/fluxo-de-decisao.md) para ranking, retries, segurança e benchmark.

A intenção principal mapeia `design`, `search`, `read` e `explain` para Planejador; `test` para Revisor; e as demais intenções para Executor. A preferência só reordena ações viáveis dentro do conjunto de candidatos existente. O fallback fica desligado por padrão; uma preferência inviável interrompe o roteamento com uma orientação explícita. Salvar a preferência vale para uma rota futura; não chama `setModel` nem altera uma chamada em andamento.

### Configuração e estado

A extensão lê e grava somente a seção `modelEconomist`. Um projeto confiável pode usar `.pi/pi-suite.yaml`; o arquivo global fica em `${PI_SUITE_HOME:-~/.pi/agent/pi-suite}/config.yaml`. Os defaults são sobrepostos pelos valores globais, depois pelos do projeto e, por último, por uma política global bloqueada. Há um exemplo de configuração em [examples/pi-suite.yaml](examples/pi-suite.yaml).

Histórico de decisões e entradas medidas ficam em JSON/JSONL local, isolado pela raiz Git canônica. Não há banco de dados. A dependência `yaml` lê a configuração.

### Idioma

O painel tem textos em inglês e português brasileiro, inclusive teclas, dicas e mensagens. Inglês é o padrão e o fallback para idioma de projeto ausente ou inválido. O idioma é lido e salvo somente como `modelEconomist.locale` no `.pi/pi-suite.yaml` do projeto confiável atual; ele nunca vem da configuração global, por isso não vaza entre projetos ou sessões.

A troca de idioma pré-visualiza o painel imediatamente e fica em rascunho até Ctrl+S; Esc avisa antes de descartá-lo, e uma falha ao salvar mantém o rascunho aberto. Em um projeto não confiável, a linha de idioma aparece bloqueada e nada é gravado.

### Privacidade e segurança

`dataPolicy` configura separadamente o tratamento para classificador, executor e telemetria. Prompts de sistema brutos, saída de ferramentas e bytes de imagem não são gravados no log de roteamento nem enviados pelo caminho de classificação desta extensão. Uma decisão de roteamento ao vivo pode ser despachada pelo Pi ao provedor selecionado no host; o pacote não substitui autenticação nem consentimento do provedor. `simulate` e o replay de benchmark não chamam modelos nem provedores. Os testes usam doubles e dados sintéticos; não comprovam comportamento pago ou de provedor externo.

### Diagnóstico e limites

- Use `/economist explain` para examinar a última decisão e as evidências disponíveis.
- Use `/economist candidates list` para conferir o pool e o escopo.
- Falta de capacidade, autenticação, saúde, janela de contexto, preço ou orçamento pode tornar uma ação inviável. Siga a recuperação indicada no erro em vez de relaxar limites de segurança.
- `pSuccess` usa resultados verificados e priors. `pSafe` permanece desconhecido até existir a amostra de risco exigida. Custo estimado não é fatura nem medição de economia.
- O smoke do carregador e do painel reais (`npm run test:host`) renderiza o painel em 40/80/120 colunas, com metadados sintéticos. Provedores reais, um terminal físico (redimensionamento, fontes) e a revisão humana exigem validação própria.

### Contribuição

Prepare o checkout e rode as verificações antes de abrir um pull request:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm test
npm run test:host
```

`npm run test:host` exige um Pi 1.6 instalado; se ele não for encontrado, defina `PI_CODING_AGENT_ENTRY` com o diretório `dist` do `pi-coding-agent` instalado. Abra pull requests para `develop`. Veja [CONTRIBUTING.md](CONTRIBUTING.md) e, para vulnerabilidades, [SECURITY.md](SECURITY.md).

### Licença

MIT, veja [LICENSE](LICENSE). O código de terceiros em `vendor/` mantém licença e procedência próprias; veja [vendor/THIRD_PARTY_NOTICES.md](vendor/THIRD_PARTY_NOTICES.md).
