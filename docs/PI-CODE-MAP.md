# Mapa do código

Componentes do Pi e do pi-durable, versão 1.4.0. Caminhos relativos a
`node_modules/@earendil-works/<pacote>/dist`. Nenhum pacote publica `src/`;
o `.js` em `dist` é saída do `tsc` com sourcemap, legível.

## 1. Camadas

```
pi-telemetry      contratos de span/métrica, sem dependências
pi-ai             → telemetry, typebox        LLM, providers, Models, streaming
pi-codemode       → quickjs-wasi              sandbox JS com tools injetadas
chord             → telemetry, typebox        Context, plugins, docs, RPC
pi-durable        → chord, pi-ai, pi-codemode, telemetry, typebox, diff, photon
pi-agent-core     → pi-ai, typebox            Agent em memória, sem durabilidade
pi-tui            → marked, ...               render de terminal
pi-mcp            → cross-spawn               cliente MCP
pi-coding-agent   → agent-core, ai, codemode, mcp, tui, ...   CLI/TUI
```

Duas consequências:

- `pi-coding-agent` **não** depende de `pi-durable`. São dois produtos: o CLI usa
  `pi-agent-core` e sessões JSONL próprias; `pi-durable` é biblioteca de harness.
- A seta aponta só para baixo. Precisa de uma tool do coding-agent dentro do
  durable? Copie/adapte; não inverta a dependência.

## 2. pi-durable: conceito → arquivo

| Conceito | Arquivo | Símbolos |
|---|---|---|
| Harness | `harness/harness.d.ts` | `Harness.open`, `DEFAULT_HARNESS_IDENTITY` |
| Tipos centrais | `harness/types.d.ts` | `Harness`, `Conversation`, `Submission`, `Tx`, `Task` |
| Sessão e commits | `session/session.d.ts`, `session/transaction.d.ts` | `createSession`, transação atômica |
| Forks | `session/forks.d.ts` | fork/cópia de conversa |
| Entries | `entries.d.ts` | `UserEntry`, `AssistantEntry`, `ToolResultEntry`, `SystemEntry`, `ResetEntry`, `CompactionEntry`, `defineEntry` |
| Documentos | `documents.d.ts` | `defineDoc`, `defineDocFamily` |
| Tasks | `tasks.d.ts`, `harness/generation.d.ts`, `harness/tool.d.ts` | `defineTask`, `GenerationTask`, `ToolTask` |
| Scheduler e inbox | `harness/scheduler.d.ts`, `harness/inbox.d.ts` | `BlockedReason`, `InboxDoc` |
| Compaction | `harness/compaction.d.ts` | `CompactionTask`, `DEFAULT_COMPACTION_POLICY` |
| Prompt | `harness/prompt.d.ts`, `harness/view.d.ts` | montagem de seções e view da conversa |
| Extensões | `harness/define.d.ts` | `defineExtension`, `defineTool`, `hook`, `section`, `wrapTool` |
| Agent por conversa | `harness/agent.d.ts` | `AgentDoc`, `DEFAULT_RETRY_POLICY`, `DEFAULT_RESTART_LIMIT` |
| Estado vivo | `harness/live.d.ts`, `harness/provider.d.ts`, `harness/usage.d.ts` | `LiveDoc`, `ProviderDoc`, `UsageDoc` |
| Eventos | `harness/events.d.ts` | `watchEvents`, `AgentEvent` |
| Storage | `storage/{memory,sqlite,jsonl,indexeddb}.d.ts` | `MemoryStorage`, `openNodeSqliteStorage`, `openNodeJsonlStorage` |
| Conformidade | `testing/*.d.ts` | `registerStorageConformance` |
| Tools embutidas | `tools/{bash,read,edit,write,image}.d.ts` | implementações próprias |
| Env/sistema | `env/node.d.ts` | filesystem, relógio |
| Code Mode | `codemode/*.d.ts` + pacote `pi-codemode` | integração do sandbox |

## 3. Fluxo de um input

```
submit({ requestId, input })
  → inbox admite e commita           harness/inbox.d.ts
  → pi.generation                    harness/generation.d.ts
      monta prompt                   harness/prompt.d.ts + agent.d.ts
      chama modelo                   pi-ai (Models/stream)
      commita pi.assistant           entries.d.ts
      cria pi.tool × n               harness/tool.d.ts
      espera resultados              harness/scheduler.d.ts
      próxima geração
  → commita resposta final
  → submission settle                harness/submissions.d.ts
```

Os documentos `pi.live` e `pi.inbox` são o estado observável desse fluxo; o
transcript é a verdade.

## 4. Ordem de leitura sugerida

1. `pi-durable/README.md` — conceitos e quick start.
2. `harness/harness.d.ts` e `harness/types.d.ts` — superfície pública.
3. `session/session.d.ts` + `session/transaction.d.ts` — o que é um commit.
4. `documents.d.ts` — documentos, versão, `checkpointWhen`.
5. `tasks.d.ts` → `harness/generation.d.ts` → `harness/tool.d.ts` — o loop.
6. `harness/prompt.d.ts` — como o histórico vira request.
7. `storage/sqlite/*` + `testing/*` — persistência e testes.
8. GitHub, no arquivo `.ts` correspondente, só para o que ainda não fechou.

## 5. pi-coding-agent: conceito → arquivo

| Conceito | Arquivo |
|---|---|
| Loop de sessão | `core/agent-session.d.ts`, `core/agent-session-runtime.d.ts` |
| Sessões JSONL (árvore, entries) | `core/session-manager.d.ts` |
| Compaction e branch summary | `core/compaction/` |
| Extensões e eventos | `core/extensions/types.d.ts` |
| Tools | `core/tools/{bash,edit,find,grep,ls,read,write}.d.ts` |
| System prompt e contexto | `core/system-prompt.d.ts`, `resource-loader.d.ts`, `skills.d.ts` |
| Settings e modelos | `core/settings-*.d.ts`, `core/model-registry.d.ts`, `core/model-resolver.d.ts` |
| Modos de execução | `modes/{interactive,print-mode,json-event,rpc}` |
| RPC e SDK | `rpc-entry.d.ts`, `core/sdk.d.ts` |

## 6. Armadilhas de nomenclatura

| Nome | Onde | O que é |
|---|---|---|
| `Session` | pi-durable `createSession` | storage + commits + transactions |
| `Session` | coding-agent `agent-session`, `session-manager` | sessão do CLI, árvore JSONL em disco |
| `compaction` | durable `harness/compaction.ts` | task durável, checkpointada |
| `compaction` | coding-agent `core/compaction/` | resumo antes do request, no loop do CLI |
| `Agent` | pi-agent-core `agent.d.ts` | agente em memória, sem log |
| `AgentDoc` | pi-durable `harness/agent.d.ts` | escolhas do agente persistidas por conversa |
| `tools` | durable `tools/` | bash, read, edit, write, image |
| `tools` | coding-agent `core/tools/` | bash, edit, find, grep, ls, read, write |

As duas implementações de compaction compartilham o formato de resumo, não o
código. Não assuma que uma mudança em uma vale para a outra.

## 7. Verificar em vez de supor

- `dist/*.d.ts` é a API da versão instalada; `package.json` fixa a versão.
- `CHANGELOG.md` do pacote diz o que mudou e por quê.
- `pi-coding-agent/docs/*.md` descreve comportamento do CLI; `examples/` mostra
  extensões e SDK funcionando.
- Para implementação, `dist/*.js` com sourcemap basta na maioria dos casos;
  só recorra ao GitHub quando o `.js` não explicar a decisão.
