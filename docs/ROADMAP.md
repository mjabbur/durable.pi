# Marco: Pi durável (CLI e depois web)

Objetivo: um agente de código com o mesmo loop do `pi` — prompt, modelo, tools,
resposta — mas com estado durável. O processo pode morrer em qualquer ponto e a
sessão continua de onde parou, com os mesmos clientes reconectando.

Ordem: CLI primeiro, web depois. A web não é outro agente: é outra vista da
mesma sessão em execução. A meta de interface é paridade com o `pi-ui`,
acompanhando o desenvolvimento dele.

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

**Tudo roda em container, CLI incluído.** O container é a fronteira de
segurança; o host só roda Docker e Tailscale. O agente executa comandos
arbitrários com permissões de usuário, e o `pi` não finge ter sandbox
(`docs/security.md`): isolamento é do ambiente. Consequências aceitas: o
workspace entra por bind rw, o SQLite fica em volume nomeado (locking quebra em
filesystem de rede) e credencial de provedor entra por env, nunca por mount de
`~/.pi`.

**Distribuição é imagem.** Não há instalação global no host. O CLI é
`docker run -it` com o `cwd` montado em `/workspace`.

**Um arquivo SQLite por sessão**, dentro do volume:
`/home/agent/.local/share/durable-pi/sessions/<id>.sqlite`. `--resume` lista
arquivos, `--fork` copia, backup é copiar do volume.

**TUI é `pi-tui`.** `@earendil-works/pi-tui` 1.4.0, MIT, sem dependência de
`pi-agent-core`. A TUI é um adaptador: `watchEvents` → entradas do transcript →
`Markdown`, `ScrollView`, `Editor`, `SelectList`. Versão exata fixada.

**Streaming é o `watchEvents`.** O evento já traz `snapshot` e deltas de
mensagem (`harness/events.d.ts`). A web usa o mesmo canal; não há protocolo
paralelo para inventar.

## M0 — Fundação: `-p` funcionando

| Passo | Entrega |
|---|---|
| 1 | `src/agent/harness.ts`: `openNodeSqliteStorage` + `Harness.open` com `CodingTools`, `env` apontando para `/workspace`, `root()` com `AgentDoc` (modelo, instruções) |
| 2 | `src/agent/sessions.ts`: caminho, criação, listagem e abertura de sessão |
| 3 | `src/cli/args.ts` + `src/cli/main.ts` + `bin/durable-pi.mjs`: `-p/--print`, `--model`, `--session-dir`, `--no-session` |
| 4 | `Dockerfile` (node 24-slim + git, ripgrep, bash), `scripts/run.sh` que monta `cwd` e o volume |
| 5 | Teste de integração com provedor fake (`MutableModels.setProvider`): prompt → tool `write` → arquivo existe → transcript persistido |

Aceite: `scripts/run.sh -p "crie hello.txt com olá"` cria o arquivo no `cwd`,
imprime a resposta e deixa sessão no volume. `--continue` na sequência vê o
histórico.

Testes e gates continuam rodando no host; o container é para executar o agente,
não para desenvolver este repositório.

## M1 — CLI interativa

- TUI sobre `pi-tui`: transcript com markdown, streaming de texto e de tool
  slot, editor com histórico, status de turno.
- `Ctrl+C` aborta a submission (`abortSubmission`), não o processo.
- `!comando` executa bash direto, fora do modelo.
- Comandos: `/compact`, `/new`, `/resume`, `/model`, `/thinking`, `/usage`.

Aceite: `kill -9` no container durante uma geração; ao reabrir, a submission
pendente termina e o transcript não tem tool call duplicada.

## M2 — Paridade durável com o CLI atual

| Recurso do `pi` | Como entra |
|---|---|
| `--continue`, `--resume`, `--fork`, `--session`, `--name` | sessões em arquivo (M0) + `fork(at)` |
| compactação automática | `DEFAULT_COMPACTION_POLICY` do Harness |
| retry e restart limit | `settings` do Harness, com `/retry` para task parkada |
| `AGENTS.md` do projeto | descoberta no `/workspace` → `AgentDoc.instructions` |
| `--thinking`, `--tools`, `--exclude-tools` | `AgentChange` + allowlist no registro |
| `--print --mode json` | serialização dos eventos, sem TUI |

Aceite: paridade funcional nos cinco cenários do runbook, incluindo crash
durante `bash` (efeito já commitado não reexecuta) e fork a partir de entrada
antiga.

## M3 — Servidor e interface web

| Passo | Entrega |
|---|---|
| 1 | `durable-pi serve --session <id> --port 8787` dentro do container, bind em `127.0.0.1` |
| 2 | API: `GET /api/sessions`, `GET /api/sessions/:id/context`, `WS /api/sessions/:id/events`, `POST submit|abort|compact` |
| 3 | SPA mobile-first: transcript, composer, stop, estado da conexão, reconexão por snapshot |
| 4 | porta publicada em `127.0.0.1:8787` no host; `tailscale serve --bg --https=443 http://127.0.0.1:8787` na frente |

Aceite: no celular, pela tailnet, enviar prompt e ver streaming; derrubar o
container no meio e subir de novo — a sessão continua e o cliente
re-sincroniza sozinho. Dois clientes abertos veem o mesmo transcript.

Autenticação: token em `~/.config/durable-pi/token` e allowlist de logins da
tailnet. Sem cadastro de usuário no v1. O container nunca bind em `0.0.0.0`
exposto à tailnet.

## M4 — Resto da paridade

MCP, skills, prompt templates, code mode, subagentes, `--mode rpc`, export
HTML. Cada um é PR próprio, sem bloquear o marco.

## Fora de escopo no v1

Temas, `pi install`/marketplace, terminal setup e UI de extensões. São conforto,
não durabilidade.

## Riscos e decisões abertas

1. **Credenciais de `git` dentro do container.** `git push` exige token ou
   agente SSH montado; o mount do socket `SSH_AUTH_SOCK` reduz o isolamento.
   Decidir no M1: token por env ou nada (commits locais apenas).
2. **Credenciais de modelo.** `createModels()` não lê a configuração do `pi`.
   `~/.config/durable-pi/models.json` no volume + env vars usuais; reusar
   `~/.pi/agent/auth.json` está descartado.
3. **`bash` sem sandbox dentro do container.** Allowlist de comandos e `cwd`
   fixo são higiene, não fronteira; a fronteira é o container. Documentar no
   runbook o que o bind do workspace expõe.
4. **Dois clientes submetendo ao mesmo tempo.** O servidor serializa; o segundo
   recebe `ConversationBusy`, que é fluxo normal e vira mensagem na UI.
5. **`pi-tui` em TTY de container.** Verificar resize, clipboard nativo e
   mouse no M1; o pacote traz prebuilds por plataforma.

## Ordem de trabalho

M0 (3 PRs: núcleo, CLI+Dockerfile, integração) → M1 (2 PRs) → M2 (3 PRs) → M3
(4 PRs). Cada PR com os três gates verdes; crash test obrigatório em todo passo
que cruza I/O novo.

## Definição de pronto do marco

Imagem construível rodando o loop completo com sessão durável, servidor web
acessível pela tailnet no celular, crash tests cobrindo geração e tool call, e
`README` com quickstart de CLI e de web via `docker run`.
