# pi-model-economist

Roteamento completo com interface discreta para **Pi 1.1.0 / Node >=20**. Não cria um proxy nem substitui autenticação. Seleção explícita de `/model economist/auto`; modelos físicos selecionados manualmente não são alterados.

## Usar

```sh
npm ci --ignore-scripts --legacy-peer-deps
pi -e ./index.ts
```

**Configure dentro do pi, não num editor.** Depois de carregar:

```
/economist setup
```

O assistente lê os modelos autenticados do registry nativo, propõe tiers por preço,
pede uma confirmação e grava em `.pi/pi-suite.yaml` do projeto (ou no config global
quando o projeto não é confiável). Ativa `economist/auto` em seguida. `/economist on`
sem candidatos faz a mesma proposta antes de falhar, em vez de deixar toda requisição
posterior com erro.

Todo subcomando tem autocomplete de argumentos nativo (`getArgumentCompletions`):
ao digitar `/economist` e dar Tab mostra cada ação com o que ela faz;` mode` mostra
os modos com o significado de cada um; `candidates add` mostra os modelos reais com
preço e janela de contexto. `/economist` sem argumento imprime o uso; um comando
errado devolve a gramática inteira.

Ajuste fino:

```
/economist candidates list
economist candidates add openrouter/qwen/qwen3-flash 1
economist candidates remove openrouter/strong/model
economist mode rules
economist policy economy
```

`mode`,` policy`,` classifier`,` classifier-model` e` candidates` persistem no arquivo
(de volta e meio por reload) e escrevem **somente** a própria seção. A lista explícita
do usuário nunca é sobrescrita: um candidato inválido é nomeado no erro com o conserto.

Instalação como pacote: `pi install ./pi-model-economist`. Remoção:` pi remove ./pi-model-economist`; selecione um modelo físico para desligar o roteamento imediatamente.

Configuração global: `${PI_SUITE_HOME:-~/.pi/agent/pi-suite}/config.yaml`. Projeto confiável: `.pi/pi-suite.yaml`. Exemplo em` examples/pi-suite.yaml`. Precedência: defaults < global < projeto <` locked` global. Candidatos devem declarar` tier`, compatibilidade` tools`, privacidade/saúde quando aplicável. Não há garantia automática de competência apenas pelo nome do modelo — o registry não publica tool-capability, então` setup` assume compatível e informa como corrigir com `--tools off`.

## Interface

`/economist on|off`,` setup`,` mode off|manual|rules|jev|small-llm|hybrid|learned`,` classifier on|off`,` classifier-model PROVIDER/ID`,` policy economy|balanced|quality|latency`,` budget task 0.50 USD`,` candidates list|add|remove`,` explain`,` json`,` simulate "pedido"`,` benchmark --dataset evals/tasks.jsonl`,` help`. Tudo com autocomplete de argumentos.

- Regras geram assessment (tipo, dificuldade, riscos, modalidades, contexto, tokens estimados, sinais). Riscos determinísticos não podem ser relaxados pelo classificador.
- Jev usa o classificador nativo (`findOfType/classify`); small-LLM usa` streamSimple` com JSON estrito, timeout, limite de geração, redação e circuito de falhas. TypeSafe usa credencial própria. Preço de Jev desconhecido exige uma cotação explícita em` classifier.decisionPrices`, ou fallback gratuito.` auto` escolhe a opção classificadora viável com menor estimativa.
- Fast path evita classificação paga para pedidos obviamente simples. Filtra modalidade, janela, ferramentas, riscos e tier. Falha verificada do gate permite escalonamento limitado a `maxEscalations`; uma afirmação do modelo não dispara escalonamento.
- Ranking inclui API, classificador, recuperação, latência e custo de troca de cache. Taxas iniciais são **priors configuráveis**, não probabilidades comprovadas. `learned` só usa amostras verificadas suficientes e exploração limitada por prêmio de custo.
- Continuação e retry de rede mantêm modelo físico. Erros de política não são retentados; context/capability podem requerer nova rota. Estado serializável é preservado pelo virtual model no branch.
- `simulate` é gratuito e não chama executor/classificador.` benchmark` é replay pareado de registros medidos, com bootstrap reproduzível; não inventa benefícios nem executa uma campanha paga. Formato de dataset em` examples/benchmark.jsonl`.

## Dados e validação

Decisões, alternativas rejeitadas, fallbacks, resultados verificados e auditoria são arquivos **JSON/JSONL**, isolados pelo hash da raiz Git canônica. Nenhum banco de dados. O custo efetivo e as chamadas diretas/classificadoras são contabilizados pelo `pi-cost-profiler`, quando instalado. Sem profiler não há bloqueio financeiro global de todos os provedores: o roteador aplica seu limite próprio e o teto do classificador.

`npm test`: regras, tiers, preço desconhecido, JSON inválido, timeout, continuidade, manuais, persistência, redação e integridade. APIs externas foram testadas com doubles, não com cobranças reais. Os IDs de exemplos são placeholders: escolha IDs efetivamente disponíveis no seu registry.
# pi-model-economist
