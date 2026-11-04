# pi-model-economist

Roteamento completo com interface discreta para **Pi 1.1.0 / Node >=20**. Não cria um proxy nem substitui autenticação. Quando habilitado, seleciona `economist/auto` em sessões novas; também permite seleção explícita por `/model economist/auto`. Escolhas manuais em conversas retomadas e modelos explícitos pela CLI são respeitados.

## Usar

```sh
npm ci --ignore-scripts --legacy-peer-deps
pi -e ./index.ts
```

**Configure dentro do pi, não num editor.** Depois de carregar:

```
/economist
```

Abre o **painel interativo**: cada item explica seu efeito. `Enter`/`Espaço` cicla
uma opção e grava na hora; `Ctrl+S` salva novamente a configuração ativa e confirma
o caminho; `Esc` volta ou fecha. O pool permite escolher um candidato e editar
tier/tools/remover na mesma tela; para adicionar use `/economist candidates add` ou
`/economist setup`. Há telas para última decisão e simulação gratuita.

Onde o cliente não tem tela customizada (JSON, print, RPC sem `custom`), `/economist`
shows um painel de estado (modo, política, pool, escopo, esforço, última decisão) e
depois as linhas de comando — nunca um despejo de gramática. Se o host **não expõe** a
tela que o painel precisa (um export que mudou de pacote, por exemplo), o painel avisa
**qual** export faltou em vez de sumir em silêncio.

Os componentes de terminal vêm do próprio pi: `index.ts` importa
`@earendil-works/pi-tui` e `@earendil-works/pi-coding-agent` **estaticamente** e os
entrega para a extensão. Isso é requisito, não estilo — `await import(...)` de um
especificador nu dentro de uma extensão é resolvido pelo Node, não pelo mapeamento de
módulos do host, e morre em `ERR_MODULE_NOT_FOUND`. `node --test` não carrega
`index.ts`, então a suíte continua rodando sem o host instalado
(`test-support/fake-tui.mjs` espelha qual pacote exporta o quê).

```
/economist setup
```

O assistente lê os modelos do escopo da sessão, propõe tiers por preço, pede uma
confirmação e grava em `.pi/pi-suite.yaml` do projeto (ou no config global quando o
projeto não é confiável). Ativa `economist/auto` em seguida. `/economist on` sem
candidatos faz a mesma proposta antes de falhar, em vez de deixar toda requisição
posterior com erro.

Todo subcomando tem autocomplete de argumentos nativo (`getArgumentCompletions`):
ao digitar `/economist` e dar Tab mostra cada ação com o que ela faz;` mode` mostra
os modos com o significado de cada um; `candidates add` mostra os modelos reais com
preço e janela de contexto. Um comando errado devolve a gramática inteira.

## Cadência de seleção e subagentes

`/economist cadence session|prompt|subagent` configura **quando** escolher o par
(modelo, esforço), separadamente de `/economist mode` (como classificar a tarefa):

- `session`: a primeira pergunta escolhe o melhor custo-benefício; o mesmo par
  fica na sessão, mesmo que o trabalho mude, até o usuário selecionar outro modelo
  com `/model`. Voltar para `economist/auto` escolhe de novo.
- `prompt` (padrão): cada pergunta é reavaliada pelo contexto recente e pelo tipo
  de trabalho. Continuações e retries compatíveis mantêm o par, para preservar
  cache e assinatura.
- `subagent`: a sessão principal reavalia como `prompt`. Quem implementa
  subagentes chama `economist_subagent_model({task})` **antes** de criar cada
  filho. A ferramenta devolve `{model, thinkingLevel}` sem mudar o pai e sem
  chamar um modelo; o implementador passa esse par ao filho. Um filho que carrega
  esta extensão e a configuração também seleciona `economist/auto` ao iniciar
  sessão nova e avalia o próprio trabalho. Processos que não integram a
  ferramenta nem carregam a extensão não podem ser roteados por este pacote.

Quando o YAML marca `enabled: true`, sessões **novas** selecionam `economist/auto`
na inicialização; uma sessão retomada com escolha manual permanece intacta. O
rodapé interativo resume `AUTO modelo · esforço efetivo` após o primeiro pedido,
sem repetir o nível virtual `medium`.

## Esforço (thinking) também é roteado

O par que o pi despacha é **(modelo físico, nível físico)**. Um `qwen:high` barato
frequentemente resolve mais que um `luna:pro:low` caro, então o roteador decide os
dois e preço a saída com o nível que *aquele* modelo vai realmente rodar
(`reasoning:false` ou `thinkingLevelMap` com `null` fazem o nível descer, nunca subir).

| chave | default | o que faz |
| --- | --- | --- |
| `thinking.mode` | `auto` | `auto` deriva o nível da dificuldade; `follow` devolve o seu `/thinking` intacto; `fixed` pin `thinking.fixed` |
| `thinking.byDifficulty` | trivial `off`, simple `low`, moderate `medium`, complex/critical `high` | mapa de dificuldade → esforço |
| `thinking.riskFloor` | `high` | **risco eleva o esforço**: produção, segurança, banco, concorrência, perda de dados |
| `thinking.ceiling` | `high` | teto absoluto do `auto` |
| `thinking.useSelectedAs` | `ceiling-if-set` | compatibilidade legada; no modo `auto` o nível virtual de `/thinking` é ignorado, pois não representa a escolha física. Use `follow` ou `fixed` para impor um nível. |
| `thinking.requireReasoningOnRisk` | `true` | tarefa arriscada exige modelo que pensa: os demais saem do ranking com `reasoning-unavailable` |
| `thinking.outputTokens` | por nível | raciocínio é cobrado como saída, então entra na estimativa de custo |

Se um modelo foi escopado com nível explícito (`openrouter/x:high` no `/scoped-models`),
isso é um **ás**: o roteador usa exatamente esse par naquele modelo.

## O pool vem do `/scoped-models`

`scope.source: scoped` (default) limita os candidatos aos modelos que o `/scoped-models`
mostra — `ctx.scopedModels`, resolvido de `enabledModels`/`--models`. Sem escopo
configurado o pi entrega a lista vazia, que significa "tudo é usável", e o pool volta a
ser o catálogo autenticado. Fora do escopo, candidatos são rejeitados com
`out-of-scope` (mesmo que uma configuração antiga tenha `scope.strict: false`).

Quando a tarefa tem imagem e nenhum modelo do escopo aceita vision, o roteador **não
falha cego**: pergunta, lista os modelos com vision ordenados pelo custo *desta* task
(preço, janela, thinking), ajuda a escolher e pergunta se mantém no pool ou usa só
desta vez. Recusar uma vez não gera nova pergunta no mesmo session e o erro que sobra
diz o comando exato de conserto. Em cliente sem UI a pergunta vira o mesmo erro
acionável. `scope helpVision off` desliga.

Ajuste fino:

```
/economist candidates list
economist candidates add openrouter/qwen/qwen3-flash 1
economist candidates remove openrouter/strong/model
economist mode rules
economist policy economy
```

`cadence`, `mode`, `policy`, `classifier`, `classifier-model` e `candidates` persistem no arquivo e
entram em efeito na hora (a escrita mergeia o patch na config viva; não peça `/reload`
para uma mudança que já aconteceu) e escrevem **somente** a própria seção. A lista explícita
do usuário nunca é sobrescrita: um candidato inválido é nomeado no erro com o conserto.

Instalação como pacote: `pi install ./pi-model-economist`. Remoção:` pi remove ./pi-model-economist`; selecione um modelo físico para desligar o roteamento imediatamente.

Configuração global: `${PI_SUITE_HOME:-~/.pi/agent/pi-suite}/config.yaml`. Projeto confiável: `.pi/pi-suite.yaml`. Exemplo em` examples/pi-suite.yaml`. Precedência: defaults < global < projeto <` locked` global. Candidatos devem declarar` tier`, compatibilidade` tools`, privacidade/saúde quando aplicável. Não há garantia automática de competência apenas pelo nome do modelo — o registry não publica tool-capability, então` setup` assume compatível e informa como corrigir com `--tools off`.

## Interface

`/economist` (painel), `on|off`, `setup`, `cadence session|prompt|subagent`, `mode off|manual|rules|jev|small-llm|hybrid|learned`, `policy economy|balanced|quality|latency`, `thinking auto|follow|fixed`, `ceiling LEVEL`, `fixed LEVEL`, `scope scoped|all`, `classifier on|off`, `classifier-model PROVIDER/ID`,` budget task 0.50 USD`,` candidates list|add|remove`,` explain`,` json`,` simulate "pedido"`,` benchmark --dataset evals/tasks.jsonl`,` help`. Tudo com autocomplete de argumentos e validado pela mesma tabela de campos que o painel, inclusive contra `locked` global.

- Regras geram assessment (tipo, dificuldade, riscos, modalidades, contexto, tokens estimados, sinais). Riscos determinísticos não podem ser relaxados pelo classificador.
- Jev usa o classificador nativo (`findOfType/classify`); small-LLM usa` streamSimple` com JSON estrito, timeout, limite de geração, redação e circuito de falhas. TypeSafe usa credencial própria. Preço de Jev desconhecido exige uma cotação explícita em` classifier.decisionPrices`, ou fallback gratuito.` auto` escolhe a opção classificadora viável com menor estimativa.
- Fast path evita classificação paga para pedidos obviamente simples. Filtra modalidade, janela, ferramentas, riscos e tier. Falha verificada do gate permite escalonamento limitado a `maxEscalations`; uma afirmação do modelo não dispara escalonamento.
- Ranking inclui API, classificador, recuperação, latência, custo de troca de cache e o **esforço que aquele modelo vai rodar**. Taxas iniciais são **priors configuráveis**, não probabilidades comprovadas. `learned` só usa amostras verificadas suficientes e exploração limitada por prêmio de custo.
- Continuação e retry de rede mantêm modelo físico. Erros de política não são retentados; context/capability podem requerer nova rota. Estado serializável é preservado pelo virtual model no branch.
- `simulate` é gratuito e não chama executor/classificador.` benchmark` é replay pareado de registros medidos, com bootstrap reproduzível; não inventa benefícios nem executa uma campanha paga. Formato de dataset em` examples/benchmark.jsonl`.

## Dados e validação

Decisões, alternativas rejeitadas, fallbacks, resultados verificados e auditoria são arquivos **JSON/JSONL**, isolados pelo hash da raiz Git canônica. Nenhum banco de dados. O custo efetivo e as chamadas diretas/classificadoras são contabilizados pelo `pi-cost-profiler`, quando instalado. Sem profiler não há bloqueio financeiro global de todos os provedores: o roteador aplica seu limite próprio e o teto do classificador.

`npm test`: regras, tiers, preço desconhecido, JSON inválido, timeout, continuidade, manuais, persistência, redação e integridade. APIs externas foram testadas com doubles, não com cobranças reais. Os IDs de exemplos são placeholders: escolha IDs efetivamente disponíveis no seu registry.

O painel é validado contra o **host instalado**, não só contra double:

```sh
node scripts/smoke-dashboard.mjs
```

Ele carrega `index.ts` pelo carregador real do pi (jiti + mapeamento de módulos), confere
qual export vem de qual pacote, monta a tela com os componentes reais e a dirige com bytes
de terminal (`↓`, `Enter`, `Esc`), provando que o menu abre, cicla, grava, entra no submenu
de dois níveis e fecha com resumo. Nenhuma chamada de modelo é feita: a decisão mostrada é
um `simulate`.

### Mudanças visíveis na 0.3.1

- **`/economist` (vazio) passa a abrir o painel.** Antes abria em nenhuma instalação real:
  `DynamicBorder` era lido do pacote errado e o `await import` do host não resolvia. Nenhuma
  config muda por causa disso.
- **A confirmação de escrita não pede mais `/reload`** — o patch já mergeia na config viva.
  Se alguém dependia da linha como dica, o comportamento continua idêntico; só a mensagem saiu.
- **Histórico 0.3.1:** `selected-as` era uma opção do painel; nesta versão foi
  removida da interface e o nível virtual não limita o esforço automático.
# pi-model-economist
