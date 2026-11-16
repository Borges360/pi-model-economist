# Pi Model Economist

Routes eligible Pi requests to a physical model-and-effort pair using configured capability, risk, quality, cost and latency signals. It does not call a model to simulate or replay a benchmark.

**Manifest:** `pi-model-economist` · **version:** `0.4.0` · **private:** `true`
**Registry status:** not verified; this checkout does not establish an npm release.
**Runtime:** Node.js `>=20`; Pi is the host. A real-loader/TUI smoke was observed with Pi CLI `1.4.0`; this is an observation, not a support matrix.

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

The root command opens the dashboard:

```text
/economist
```

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

The extension reads and writes only its `modelEconomist` configuration section. A trusted project can use `.pi/pi-suite.yaml`; the global file is `${PI_SUITE_HOME:-~/.pi/agent/pi-suite}/config.yaml`. Defaults are overridden by global values, project values and then a locked global policy. The `/economist` dashboard defaults to English and offers English or Brazilian Portuguese. The locale is read and saved only as `modelEconomist.locale` in the current trusted project's `.pi/pi-suite.yaml`; it is never inherited from global configuration. Changing language previews the dashboard immediately; Ctrl+S saves the draft, while root Esc warns before discarding it. An untrusted project may preview a language but cannot save that preference.

Decision history and measured inputs use local JSON/JSONL storage scoped by the canonical Git root. There is no database. The `yaml` dependency parses configuration.

### Language

The dashboard is localized in English and Brazilian Portuguese. English is the default and fallback for missing or invalid project locale values. Menu copy previews immediately and remains a draft until Ctrl+S; failed saves keep the draft open. Language preference belongs to the current trusted project and does not leak between projects or sessions.

### Privacy and security

`dataPolicy` configures handling for the classifier, executor and telemetry separately. Raw system prompts, tool stdout and image bytes are not written to the route log or sent by this extension's classifier path. A live routing decision may be dispatched by Pi to the provider selected in the host; this package does not replace provider authentication or consent. `simulate` and benchmark replay make no model/provider call. Tests use doubles and synthetic data; they do not demonstrate paid or external-provider behavior.

### Troubleshooting and limits

- Use `/economist explain` to inspect the last decision and its available evidence.
- Use `/economist candidates list` to check the configured pool and scope.
- Missing model capability, authentication, health, context, price or budget can make an action infeasible; follow the recovery command in the error instead of relaxing safety limits.
- `pSuccess` uses verified outcomes and priors. `pSafe` remains unknown until the required risk samples exist. Estimated cost is not an invoice or a savings measurement.
- The real Pi loader/TUI smoke was observed on Pi CLI `1.4.0` with synthetic model metadata; other host versions and provider integrations are not certified by that smoke.

### License

The product manifest does not declare a software license, and no product license is asserted here. The bundled INTEIRO mark has a separate MIT notice in [its attribution file](docs/assets/INTEIRO-MARK-LICENSE.txt).

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

O comando raiz abre o painel:

```text
/economist
```

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

A extensão lê e grava somente a seção `modelEconomist`. Um projeto confiável pode usar `.pi/pi-suite.yaml`; o arquivo global fica em `${PI_SUITE_HOME:-~/.pi/agent/pi-suite}/config.yaml`. Defaults recebem overrides global, de projeto e, por último, uma política global bloqueada. O painel `/economist` abre em inglês e oferece inglês ou português brasileiro. O idioma é lido e salvo somente como `modelEconomist.locale` no `.pi/pi-suite.yaml` do projeto confiável atual; ele nunca vem da configuração global. A troca pré-visualiza o painel imediatamente; Ctrl+S salva o rascunho e Esc na raiz avisa antes de descartá-lo. Um projeto não confiável pode pré-visualizar o idioma, mas não salvar essa preferência.

Histórico de decisões e entradas medidas ficam em JSON/JSONL local, isolado pela raiz Git canônica. Não há banco de dados. A dependência `yaml` lê a configuração.

### Idioma

O painel tem textos em inglês e português brasileiro. Inglês é o padrão e o fallback para idioma de projeto ausente ou inválido. A prévia do menu é imediata e fica em rascunho até Ctrl+S; uma falha ao salvar mantém o rascunho aberto. A preferência pertence ao projeto confiável atual e não vaza entre projetos ou sessões.

### Privacidade e segurança

`dataPolicy` configura separadamente o tratamento para classificador, executor e telemetria. Prompts de sistema brutos, saída de ferramentas e bytes de imagem não são gravados no log de roteamento nem enviados pelo caminho de classificação desta extensão. Uma decisão de roteamento ao vivo pode ser despachada pelo Pi ao provedor selecionado no host; o pacote não substitui autenticação ou consentimento do provedor. `simulate` e replay de benchmark não chamam modelos ou provedores. Os testes usam doubles e dados sintéticos; não comprovam comportamento pago ou de provedor externo.

### Diagnóstico e limites

- Use `/economist explain` para examinar a decisão e as evidências disponíveis.
- Use `/economist candidates list` para conferir pool e escopo.
- Falta de capacidade, autenticação, saúde, janela de contexto, preço ou orçamento pode tornar uma ação inviável; siga a recuperação indicada em vez de relaxar limites de segurança.
- `pSuccess` usa resultados verificados e priors. `pSafe` permanece desconhecido até existir a amostra de risco exigida. Custo estimado não é fatura nem medição de economia.
- O smoke do carregador e do painel reais do Pi foi observado no Pi CLI `1.4.0`, com metadados sintéticos; outras versões do host e integrações com provedores não são certificadas por esse smoke.

### Licença

O manifesto não declara licença de software para o produto; este README não afirma uma. A marca INTEIRO incluída tem aviso MIT separado em [seu arquivo de atribuição](docs/assets/INTEIRO-MARK-LICENSE.txt).
