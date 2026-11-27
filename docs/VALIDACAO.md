# Validação da suíte

## Evidência local

Ambiente executado: Windows, Node 24.14.0, Pi 1.1.0.

| Pacote | Versão | Testes passando |
| --- | --- | ---: |
| pi-model-economist | 0.4.0 | 99 |
| pi-acceptance-gate | 0.2.0 | 21 |
| pi-loop-guard | 0.2.0 | 15 |
| pi-cost-profiler | 0.2.0 | 17 |
| pi-mcp-control | 0.2.0 | 17 |
| Total |  | 169 |

Comando em cada diretório: `npm test` (`node --test`).

Em pi-model-economist, o painel é validado contra o host instalado (componentes reais,
carregador real, nenhuma chamada de modelo):

```sh
node scripts/smoke-dashboard.mjs
```

Resultado em 23/11/2026 (Pi 1.6.0 instalado; também passa com `PI_CODING_AGENT_ENTRY` apontando
para o 1.5.2):

```
PASS Pi 1.6.0: real loader, 3 tools, isolated copy without node_modules/pi-tui, preset ↓↓Enter↑Enter, Ctrl+S keeps it open, pt-BR preview, Esc warns then discards, pool, simulation, 11 frames at 40/80/120 columns, offline evaluation thread, no provider calls.
```

O painel usa a cópia vendorizada do adaptador em `vendor/inteiro-terminal/`, que importa
`@earendil-works/pi-tui` de forma estática. O smoke carrega também uma cópia isolada, só com os
arquivos publicados e sem `node_modules/pi-tui`, para provar que o carregador do Pi entrega o
módulo do host. Um smoke anterior expôs dois bugs que os testes de unidade não viam: um export
lido do pacote errado e um `await import` preguiçoso do host, que o Node resolve nativamente e
derruba com `ERR_MODULE_NOT_FOUND`. Avaliação humana em terminal físico continua separada.

No diretório pi-cost-profiler:

```sh
node scripts/smoke-pi.mjs /caminho/instalado/pi-coding-agent/dist/cli.js
node scripts/smoke-dispatch.mjs /caminho/instalado/pi-coding-agent/dist/cli.js
```

Resultados:

```json
{"piStartup":"passed","commands":["economist","gate","guard","cost","mcpc"],"providerCalls":0}
{"nativeDispatch":"passed","billingPrecedence":"passed","hardBudgetBeforeDispatch":"passed","remoteCalls":0}
```

O primeiro teste inicializa os cinco pacotes juntos no runtime real em RPC, sem prompt de modelo. O segundo usa um provedor local determinístico, pelo dispatch real do Pi, para verificar contabilidade e negação preventiva. Nenhum deles faz chamada remota/paga.

## Fronteiras da validação

- Jev e small-LLM: adaptadores testados com doubles, JSON inválido, indisponibilidade, timeout e redação. Não houve autenticação/cobrança real nestes testes.
- MCP: autorização, trust, limites, precedência, URLs, stdio e nested calls testados localmente. Servidores remotos de produção não foram acionados.
- MCPHub local: esquema `mcp_settings.json` confirmado por inspeção de metadados (`mcpServers`, 3 entradas). Adaptador de arquivo, com consentimento, sem supor uma API HTTP não verificada.
- Benchmark: leitura offline de uma matriz já medida (até 1000 linhas), ou replay reproduzível de registros fornecidos; não uma campanha paga. RouterBench não foi baixado e nenhum peso de rede foi commitado. Não há alegação de economia medida.
- CI Windows/Linux e Node 20/22/24: workflow criado; não executado remotamente nesta sessão.
- Verificadores Maven/Gradle/Go/infra dependem dos executáveis e contratos reais do projeto. Testes locais de processo/checkers usaram Node.

## Armazenamento

Exclusivamente JSON/JSONL, arquivos protegidos de assinatura e exports atômicos. Nenhum banco de dados, driver SQL, SQLite, serviço de banco ou ORM. Coleções têm schemaVersion e recusa de versões incompatíveis. Falhas de política são fail-closed; falhas de observabilidade informativa são reportadas sem fabricar métricas.

HMAC local detecta adulteração; não substitui isolamento do SO ou autenticação de uma organização. O mesmo vale para regex/hints MCP e estimativas de orçamento: limitações específicas estão nos READMEs.
