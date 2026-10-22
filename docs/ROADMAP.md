# Marco: Pi durável (CLI e depois web)

Objetivo: um agente de código com o mesmo loop do `pi` — prompt, modelo, tools,
resposta — mas com estado durável. O processo pode morrer em qualquer ponto e a
sessão continua de onde parou, com os mesmos clientes reconectando.

Ordem: CLI primeiro, web depois. A web não é outro agente: é outra vista da
mesma sessão em execução.

## Decisões de arquitetura

**Um dono do storage.** `pi-durable` exige um processo por storage
(`AGENTS.md`, Durabilidade). Logo, o agente roda num processo dono do SQLite e
tanto o CLI quanto o navegador são clientes dele. No M0–M2 o CLI é esse
processo; no M3 ele vira `durable-pi serve` e o CLI passa a anexar por socket.

```
M0–M2:  durable-pi (CLI)  ── dono do SQLite
M3:     durable-pi serve  ── dono do SQLite ── HTTP/WS ──┬── CLI (attach)
                                                        └── browser (Tailscale)
```

**Núcleo separado do cliente desde o primeiro PR.** `src/agent/` monta o
Harness, o registro de tools e a sessão; `src/cli/` só lê argumentos e desenha.
Sem isso, o M3 vira refatoração.

**Um arquivo SQLite por sessão.** `~/.local/share/durable-pi/sessions/<id>.sqlite`.
`--resume` lista arquivos, `--fork` copia, backup é `cp`. Custo: nenhuma consulta
cruzada entre sessões — que não é requisito.

**Streaming é o `watchEvents`.** O evento já traz `snapshot` e deltas de
mensagem (`harness/events.d.ts`). A web usa o mesmo canal; não há protocolo
paralelo para inventar.

## M0 — Fundação: `-p` funcionando

| Passo | Entrega |
|---|---|
| 1 | `src/agent/harness.ts`: `openNodeSqliteStorage` + `Harness.open` com `CodingTools`, `env` apontando para o `cwd`, `root()` com `AgentDoc` (modelo, instruções) |
| 2 | `src/agent/sessions.ts`: caminho, criação, listagem e abertura de sessão |
| 3 | `src/cli/args.ts` + `src/cli/main.ts` + `bin/durable-pi.mjs`: `-p/--print`, `--model`, `--session-dir`, `--no-session` |
| 4 | Teste de integração com provedor fake (`MutableModels.setProvider`): prompt → tool `write` → arquivo existe → transcript persistido |

Aceite: `durable-pi -p "crie hello.txt com olá"` cria o arquivo, imprime a
resposta e deixa sessão em disco. `--continue` na sequência vê o histórico.

## M1 — CLI interativa

- REPL com streaming de texto e de tool slot, indicador de turno em andamento.
- `Ctrl+C` aborta a submission (`abortSubmission`), não o processo.
- `!comando` executa bash direto, fora do modelo.
- Comandos: `/compact`, `/new`, `/resume`, `/model`, `/thinking`, `/usage`.

Aceite: `kill -9` no meio de uma geração; ao reabrir, a submission pendente
termina e o transcript não tem tool call duplicada.

## M2 — Paridade durável com o CLI atual

| Recurso do `pi` | Como entra |
|---|---|
| `--continue`, `--resume`, `--fork`, `--session`, `--name` | sessões em arquivo (M0) + `fork(at)` |
| compactação automática | `DEFAULT_COMPACTION_POLICY` do Harness |
| retry e restart limit | `settings` do Harness, com `/retry` para task parkada |
| `AGENTS.md` do projeto | descoberta no `cwd` → `AgentDoc.instructions` |
| `--thinking`, `--tools`, `--exclude-tools` | `AgentChange` + allowlist no registro |
| `--print --mode json` | serialização dos eventos, sem TUI |

Aceite: paridade funcional nos cinco cenários do runbook, incluindo crash
durante `bash` (efeito já commitado não reexecuta) e fork a partir de entrada
antiga.

## M3 — Servidor e interface web

| Passo | Entrega |
|---|---|
| 1 | `durable-pi serve --session <id> --port 8787`, bind em `127.0.0.1` |
| 2 | API: `GET /api/sessions`, `GET /api/sessions/:id/context`, `WS /api/sessions/:id/events`, `POST submit|abort|compact` |
| 3 | SPA mobile-first: transcript, composer, stop, estado da conexão, reconexão por snapshot |
| 4 | `tailscale serve --bg --https=443 http://127.0.0.1:8787`, auth por token + identidade da tailnet |

Aceite: no celular, pela tailnet, enviar prompt e ver streaming; derrubar o
daemon no meio e reabrir — a sessão continua e o cliente re-sincroniza sozinho.
Dois clientes abertos veem o mesmo transcript.

Autenticação: token em `~/.config/durable-pi/token` e allowlist de logins da
tailnet. Sem cadastro de usuário no v1. Nunca bind em `0.0.0.0`.

## M4 — Resto da paridade

MCP, skills, prompt templates, code mode, subagentes, `--mode rpc`, export
HTML. Cada um é PR próprio, sem bloquear o marco.

## Fora de escopo no v1

TUI fullscreen com widgets, temas, `pi install`/marketplace, terminal setup e
UI de extensões. São conforto, não durabilidade.

## Riscos e decisões abertas

1. **TUI própria ou `pi-tui`.** `pi-tui` não é dependência deste repositório;
   adicionar é dependência nova. Proposta: ANSI próprio no M1, reavaliar no M2.
2. **Credenciais de modelo.** `createModels()` não lê a configuração do `pi`.
   Precisamos de `~/.config/durable-pi/models.json` e das env vars usuais;
   reusar `~/.pi/agent/auth.json` exige decisão explícita.
3. **Permissão de tool.** `bash` roda sem sandbox. No v1: allowlist de comandos
   e `cwd` fixo, com o risco documentado no runbook.
4. **Dois clientes submetendo ao mesmo tempo.** O servidor serializa; o segundo
   recebe `ConversationBusy`, que é fluxo normal e vira mensagem na UI.

## Ordem de trabalho

M0 (2 PRs) → M1 (2 PRs) → M2 (3 PRs) → M3 (4 PRs). Cada PR com os três gates
verdes; crash test obrigatório em todo passo que cruza I/O novo.

## Definição de pronto do marco

CLI instalável rodando o loop completo com sessão durável, servidor web
acessível pela tailnet no celular, crash tests cobrindo geração e tool call, e
`README` com quickstart de CLI e de web.
