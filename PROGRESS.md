# PROGRESS

Handoff. Estado, decisões e próximo passo; detalhe fica em `docs/`.

## Estado

- `main` em `dbb6a16` + PR do shell no fechamento: 130 testes em 21 arquivos,
  gates verdes (`typecheck`, `build`, `lint`, `test`).
- M1.2 em andamento: itens 1, 3, 5, 7 (PRs #40–#42) e agora 2 e 6 fechados
  com spec, teste e auditoria do Sol; resta o item 4 (`void command()` sem
  `catch`).
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
- `!comando` no fechamento: a TUI só considera "interrompido" quando a
  **execução** não terminou; commit lento é aguardado. Por isso `executeShell` e
  `commitShell` são separados. As duas escritas (normal e interrupção) usam o
  mesmo `requestId`, então no máximo uma entrada existe.
- Fechamento nunca fica pendurado em processo que não morre: prazo de 3 s,
  entrada de interrupção sem desfecho e `process.exit` de segurança no shim
  (1 s, `unref`) para descendente que mantém o pipe aberto.
- Comando local (`!`) continua sem intenção durável: exceção declarada ao
  `AGENTS.md`, registrada em `specs/shell-shutdown/spec.md`.
- Troca de sessão é do `main()`, não da TUI: `runTui` recebe um `SessionSwitcher`
  (`list`/`open`/`create`) e só pede. A troca abre a sessão nova antes de fechar
  a anterior — lock é por arquivo, então os dois Harnesss não disputam o mesmo
  storage — e a TUI para o `watchEvents` antigo antes de reatar no novo, com um
  contador de attachment para descartar eventos atrasados.

## Próximo: fechar as médias da auditoria do M1.1

Decisão do dono em 2026-10-22: as médias vêm antes do M2. O memd foi atualizado
nessa data (instalação de versão nova); `P-021` rev 2 está ativa com a lista.
Ordem sugerida, cada item com teste:

1. ~~`!comando` no fechamento~~: feito em `specs/shell-shutdown/`. `finish()`
   espera o desfecho; o prazo de 3 s cobre só o processo, e o commit lento é
   aguardado (`executeShell` + `commitShell` separados, mesmo `requestId` nas
   duas escritas). Descendente que escapa do grupo: entrada de interrupção e
   saída forçada pelo shim após 1 s. Cobertura: `test/spec/shell-shutdown.test.ts`
   (muse) + três testes manuais em `test/tui/app.test.ts`.
2. Falha de `attach` na troca (`src/tui/app.ts`, `switchSession`): o aviso é
   apagado por `notices.length = 0` e o reattach de handle fechado é silenciado.
   Emitir o aviso depois do reattach e distinguir falha de abertura de falha
   após a troca.
3. ~~Exibição no reducer~~: feito em `specs/transcript-events/`. `parts` por
   `contentIndex` com `streaming` derivado; variantes `text_start`/`thinking_start`/
   `block`/`message`; `trimStart` sobre a janela do produtor (recorte só na
   exibição); slot `done` do snapshot não sobrescreve resultado lido e `done`
   sem `entry` aparece como erro. Cobertura: `test/spec/transcript-events.test.ts`
   (muse) + três testes manuais em `test/tui/transcript.test.ts`.
4. ~~`void command(prompt)` sem `catch`~~: feito em `specs/command-errors/`.
   Fronteira `reportCommandError` (já existia desde o #40) ganhou `if (exited)`;
   o `onSelect` do seletor passou a usá-la; `finish()` resolve a saída mesmo se
   `tui.stop()` lançar; cadeias de `closed` têm `catch`. Cobertura manual em
   `test/tui/app.test.ts` (rejeição de `list` + prompt seguinte + nenhum
   `unhandledRejection`); geração do muse não foi adotada (motivo na spec).
5. Sanitizar ANSI/OSC da saída externa (shell e tools) antes de renderizar.
6. Falha de storage na TUI: imprimir `sessão: <id>` como o modo `-p` faz.
7. ~~`parseModelRef`~~: feito em `specs/model-ref/`; partes vazias depois do
   `trim` rejeitam com `InvalidModelRefError`. Cobertura:
   `test/spec/model-ref.test.ts` (muse, 8 testes). rejeitar partes só com espaços.

Depois disso, M2 — paridade durável:

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
- `trimStart` de `tool_execution_update` é contado na janela do produtor, em
  unidades UTF-16, e não no texto já recortado pela TUI: guarde a janela e
  corte só ao desenhar.
- Em fechamento, não use a promise `done` (execução + commit) como sinal de
  "processo travado": commit lento vira interrupção falsa. Espere a execução,
  depois o commit sem prazo.
- Teste de shutdown com escrita barrada precisa barrar só a primeira escrita;
  senão o fallback também fica preso e o teste não distingue os caminhos.
- `conversation.abort()` marca a task e espera a invocação em curso: com
  provedor que ignora o sinal, o status fica em "cancelando" até ele responder.
  O teste solta o provedor e só então exige idle e descarte da resposta.
- `waitForIdle()` pode resolver antes de o `watch()` limpar o turno. Em teste de
  `Ctrl+C`, espere um frame novo com "ocioso" (`terminal.since(marca)`) — usar
  `terminal.text` acumulado dá falso positivo do primeiro render.
- `vitest -t "Ctrl+C"` é regex: o `+` faz o filtro não casar e o arquivo inteiro
  aparece como "skipped". Use outro trecho do nome.
- Fixture `main-child.mjs` tem o modo `crash-admitted`: submissão colocada,
  `Control.pending` limpo e `SIGKILL` na requisição, para que só `resume()`
  possa concluir (isola a retomada da reconciliação de intenções).

## Bloqueios

Nenhum.
