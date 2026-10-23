# PROGRESS

Handoff. Estado, decisões e próximo passo; detalhe fica em `docs/`.

## Estado

- `main` com a TUI completa do M1 e a correção do M1.1, 120 testes em 20
  arquivos, gates verdes (`typecheck`, `build`, `lint`, `test`).
- CLI `durable-pi -p` funcional sobre SQLite: sessões, `--model`, `--session`,
  `-c`, `--no-session`, config de modelo, lock, workspace do host.
- Imagem validada no WSL com `wslc` 3.0.3.0 (build, volume, bind, sessão
  persistida). Caminho docker/podman escrito e testado por wrapper falso.
- M1 fechado: `durable-pi` sem `-p` abre a TUI (transcript com streaming,
  editor, `Ctrl+C` aborta geração ou `!comando`; `/help`, `/usage`, `/compact`,
  `/model`, `/thinking`, `/new`, `/resume` com seletor, `/quit` e `!comando`).
  Aceite de crash coberto por teste de processo: `SIGKILL` depois de o efeito
  de uma tool estar commitado, retomada com `--session`, um par chamada/resultado
  e o efeito não repetido.
- M1.1: auditoria externa (`docs/audits/2026-10-22-m1-1.md`) mostrou que o aceite
  valia só no modo `-p`. A TUI agora chama `harness.resume()` e reconcilia as
  intenções pendentes no `attach()`, aborta com `conversation.abort()` e reserva
  o turno antes do primeiro `await`. Coberto por `test/tui/app.test.ts` (retomada
  sem novo prompt, cancelamento com provedor travado, duas entradas seguidas) e
  por `resumePendingIntents` em `test/agent/harness.test.ts`.
- Recuperação e precedência de modelo provadas pelo `main()`; resta só o lock
  entre dois containers reais.

## Estrutura

```
src/agent/    harness.ts (openAgent, submit, watch, ask, closeAgent),
              shell.ts (runShell: `!comando` como entrada de exibição),
              control.ts (app.control v2: workspace + intenções),
              lock.ts (BEGIN EXCLUSIVE em <db>.lock),
              config.ts (modelo padrão), models.ts (catálogo pi-ai),
              sessions.ts (ids, listagem, WAL), fs-errors.ts
src/cli/      args.ts (parse puro), main.ts (ciclo de vida, códigos de saída)
src/tui/      transcript.ts (reducer puro de AgentEvent), app.ts (TUI),
              theme.ts (temas neutros)
bin/          durable-pi.mjs
scripts/      run.sh (container), bakeoff.sh, container.conf.example
test/         invariants, crash (fixture, charge, agent, main), agent/*,
              cli/*, tui/*, scripts/*, spec/, agent/handoff.muse.test.ts (gerado)
specs/        counter, charge, handoff
docs/         DURABILITY, PI-CODE-MAP, ROADMAP, RUNBOOK, audits/
```

## Comandos

```bash
npm run typecheck && npm run lint && npm run test   # pronto = três verdes
npm run build                                       # tsc -p tsconfig.build.json
scripts/run.sh -p "..." --model provider/modelo     # container
scripts/run.sh --runtime-info                       # detecta runtime sem executar
"$WSL" build -t durable-pi:dev .                    # rebuild após mudar src/
```

`npm test` roda `pretest` (build), porque `test/crash-agent.test.ts` executa
`dist/`.
## Decisões que não devem ser reabertas sem motivo

- Node 24, ESM, sem Bun. `pi-durable` 1.4.0 fixo; API conferida em
  `node_modules/@earendil-works/pi-durable/dist/*.d.ts`.
- Um processo por storage; o lock é um SQLite auxiliar com `BEGIN EXCLUSIVE`
  (arquivo `PID` e unix socket foram descartados: janela e corrida de `unlink`).
- Modelo padrão vem de `~/.config/durable-pi/config.json`
  (`DURABLE_PI_AGENT_CONFIG`), ordem `--model` → `DURABLE_PI_MODEL` → config.
  `--model` não é pegajoso.
- Sessão vinculada ao workspace do host (`DURABLE_PI_WORKSPACE`, enviado pelo
  `run.sh`), não só ao `cwd` — dentro do container todo repo é `/workspace`.
- Env entra por `--env-file` (0600, temporário). `wslc -e NAME` sem valor não
  repassa nada.
- Recuperação exige a mesma sessão: sem `--session`/`-c` o CLI cria outro
  banco. Em falha ele imprime `sessão: <id>`.
- `main(argv, { models })`: o catálogo é injetável só para teste. É o único
  jeito de exercitar o caminho real do CLI (resolver sessão, abrir banco,
  admitir) contra o provedor faux; `AgentOptions.models` já tinha o mesmo
  ponto de injeção.
- `submit()` admite, `watch()` espera e lê, `ask()` é açúcar. Handoff entre
  frontends é por `requestId`; handle de `Submission` não atravessa processo.
- Testes de contrato são gerados por `muse-spark-1.3-contributor` com
  `--thinking low`, a partir de `specs/<slug>/spec.md`; spec ambígua vira teste
  errado (aconteceu duas vezes no handoff).
- A TUI desenha a partir de `watchEvents`, com um reducer puro
  (`src/tui/transcript.ts`) entre o evento e o componente. O estado inicial é o
  snapshot: transcript comprometido mais mensagem em voo, então reabrir no meio
  da geração mostra o parcial. `AssistantEntry`/`ToolResultEntry` finalizam o
  que o evento de execução já mostrou — a dedupe é por id de entrada.
- `Terminal` é injetável na TUI: `test/tui/app.test.ts` dirige a interface
  inteira com terminal falso, sem TTY. Não troque isso por `VirtualTerminal`
  (dependência nova) sem motivo.

- `!comando` roda fora do modelo e grava o resultado como `write` de exibição
  (`kind: "durable.shell"`), então o bloco sobrevive ao resume sem entrar no
  contexto do modelo. Comando interrompido não é reexecutado: não há intenção
  durável para ele, só o resultado.
- Observador não liga o scheduler: `watchEvents` só lê. Quem reabre chama
  `harness.resume()`, e as intenções de `Control.pending` são reenviadas com o
  mesmo `requestId` (`resumePendingIntents`), que é idempotente. Sem os dois,
  reabrir mostrava "ocioso" com submissão parada.
- Aborto de geração é `conversation.abort()`, que marca a task e espera o
  escopo ficar idle; `Submission.abort()` só retira input na fila e devolve
  `already_placed` para o que já começou. O turno é reservado antes do primeiro
  `await` e liberado só pelo dono, para duas entradas não abrirem duas gerações.
- Troca de sessão é recusada com geração em voo: fechar o Harness antigo deixaria
  a submissão sem quem a acompanhe.
- Troca de sessão é do `main()`, não da TUI: `runTui` recebe um `SessionSwitcher`
  (`list`/`open`/`create`) e só pede. A troca abre a sessão nova antes de fechar
  a anterior — lock é por arquivo, então os dois Harnesss não disputam o mesmo
  storage — e a TUI para o `watchEvents` antigo antes de reatar no novo, com um
  contador de attachment para descartar eventos atrasados.

## Próximo: M2 — paridade durável

O que já está de pé no M1: TUI com streaming, abort por `Ctrl+C` (segundo sai),
`/help`, `/usage`, `/compact`, `/model`, `/thinking`, `/new`, `/resume`,
`/quit`, `!comando`, e erro de uso quando não há TTY.

Ordem sugerida do M2:

1. `AGENTS.md` do projeto no `/workspace` → `AgentDoc.instructions` (hoje o
   prompt é só o `DEFAULT_INSTRUCTIONS`).
2. `--thinking`, `--tools`/`--exclude-tools` e `--name` no CLI; `--fork <id>`
   com `conversation.fork(at)`.
3. `--print --mode json`: serialização dos mesmos eventos do `watchEvents`.
4. Compactação automática com `DEFAULT_COMPACTION_POLICY` e `/retry` para task
   parkada.

Limite: a TUI é dona do storage (um processo por storage). Quando o servidor
web do M3 existir, o CLI/TUI passa a anexar ao `serve` em vez de abrir o banco.

## Pendências

- Sobras da auditoria do M1.1 (médias/baixas, em `docs/audits/2026-10-22-m1-1.md`):
  `/quit`/`/new` com `!comando` em execução perde o registro; falha de `attach`
  na troca apaga o próprio aviso; reducer ignora `text_start`/`block`/`message`
  e o slot `done` do snapshot sobrescreve resultado lido; `void command()` sem
  `catch`; saída externa sem sanitizar ANSI/OSC; falha de storage na TUI não
  imprime `sessão: <id>`; `parseModelRef` aceita partes em branco.
- Push a partir do container (M3): sem credencial dentro; push no host.
- Gate de `test/spec/` no CI: decidir como distinguir correção de spec de teste
  acomodado (duas perguntas antigas continuam válidas).
- Tailscale no M3: decidir onde roda (Windows publicando porta do `wslc -p` vs
  `tailscale serve` dentro do WSL).
- Sobras da auditoria do M1.0: lock entre dois containers reais (os outros dois
  itens — crash pelo `main()` e precedência `--model` — fecharam em
  `test/crash-main.test.ts` e `test/cli/main.test.ts`).

## Armadilhas conhecidas

- Depois de mudar `src/`, a imagem precisa de rebuild; `scripts/run.sh` não
  rebuilda.
- No WSL: sem docker e sem podman; `wslc` é binário Windows fora do PATH.
- `test/scripts/run-sh.test.ts` roda com `PATH` mínimo: `mktemp` não existe,
  então o teste fixa `DURABLE_PI_ENV_FILE`.
- Fixture que importa `dist/` (agente, main, charge) exige `npm run build`
  antes: `npx vitest run` sozinho usa o `dist/` velho e o filho falha por
  outra razão que não a testada.
- `ConversationId` é `number` com brand; `AskOutcome` usa `settled.answer`
  (EntryId) e a resposta se lê com `tx.entry(AssistantEntry, ...)`.
- Ferramenta de teste falsa exige `stopReason: "toolUse"` para executar tool;
  `stopReason: "error"` vira `reason: model_error`.
- O provedor faux entrega a mensagem inteira: não sai `message_update` com
  `text_delta` (só `message_start` e `message_end`). O caminho de streaming do
  reducer é coberto com eventos montados à mão, e o resto com eventos reais.
- `Terminal` do `pi-tui` 1.4.0 tem `drainInput`, `kittyProtocolActive`,
  `setTitle`, `setProgress` e `setProgramStatus` além do que o README mostra;
  terminal falso precisa dos cinco.
- `main()` interativo só roda com TTY, então o teste de troca de sessão é na
  TUI, com terminal falso e um `SessionSwitcher` de teste; o caminho
  `main()`→`swapSession` não tem teste próprio (é cola fina sobre `openAgent`).

## Bloqueios

Nenhum.
