# PROGRESS

Handoff. Estado, decisões e próximo passo; detalhe fica em `docs/`.

## Estado

- `main` em `8140a0e`, 99 testes em 17 arquivos, gates verdes
  (`typecheck`, `build`, `lint`, `test`).
- CLI `durable-pi -p` funcional sobre SQLite: sessões, `--model`, `--session`,
  `-c`, `--no-session`, config de modelo, lock, workspace do host.
- Imagem validada no WSL com `wslc` 3.0.3.0 (build, volume, bind, sessão
  persistida). Caminho docker/podman escrito e testado por wrapper falso.
- TUI ainda não existe: é o M1.

## Estrutura

```
src/agent/    harness.ts (openAgent, submit, watch, ask, closeAgent),
              control.ts (app.control v2: workspace + intenções),
              lock.ts (BEGIN EXCLUSIVE em <db>.lock),
              config.ts (modelo padrão), models.ts (catálogo pi-ai),
              sessions.ts (ids, listagem, WAL), fs-errors.ts
src/cli/      args.ts (parse puro), main.ts (ciclo de vida, códigos de saída)
bin/          durable-pi.mjs
scripts/      run.sh (container), bakeoff.sh, container.conf.example
test/         invariants, crash (fixture, charge, agent, main), agent/*,
              cli/*, scripts/*, spec/, agent/handoff.muse.test.ts (gerado)
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

## Próximo: M1 — TUI sobre `pi-tui`

Ordem sugerida:

1. `src/tui/` com `ProcessTerminal` + `Editor` + `Markdown`/`ScrollView`;
   streaming por `watchEvents` sobre `harness`, não por polling de estado.
2. `Ctrl+C` = `submission.abort(context)`; segundo `Ctrl+C` sai.
3. Comandos: `/new`, `/resume`, `/model`, `/thinking`, `/usage`, `/compact`.
4. Enquanto não houver chave de API, provar a TUI com `fauxProvider`.

Limite: a TUI é dona do storage (um processo por storage). Quando o servidor
web do M3 existir, o CLI/TUI passa a anexar ao `serve` em vez de abrir o banco.

## Pendências

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

## Bloqueios

Nenhum.
