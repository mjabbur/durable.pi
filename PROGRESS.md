# PROGRESS

## Estado

- Gates verdes: typecheck, lint, build e 36 testes (3 invariante, 8 counter,
  9 charge, 4 crash de fixture, 3 crash de `chargeOnce`, 3 do núcleo do
  agente, 6 do CLI).
- `src/counter.ts` e `src/charge.ts` implementados contra as specs.
- Bake-off fechado: `muse-spark-1.3-contributor`, `--thinking low`, medida por
  artefato.
- Repositório inicializado; nenhuma API pública exportada ainda.

## Decisões

Ver tabela em `NOTES.md`. Em resumo: Node 24, sem Bun; pi-durable fixado em
1.4.0; testes derivados da spec por agente separado; `low` como nível de
raciocínio.

## Próximos passos

M0 concluído: `src/agent/` (Harness + `CodingTools`), CLI `-p` com sessão em
SQLite, `Dockerfile` e `scripts/run.sh`. M1 é a TUI sobre `pi-tui`.
`src/index.ts` e mapa `exports` só quando o projeto virar biblioteca.

## Auditoria do M0

Relatório em `docs/audits/2026-10-22-m0.md`. Corrigidos até aqui:

- CLI: erro de preparação/limpeza contido em `main()`, id inválido vira código
  2, flag sem valor não consome a opção seguinte, `listSessions` distingue
  ausência de erro e considera o WAL.
- Núcleo: lock exclusivo por storage, `cwd` gravado e conferido na reabertura,
  `--model` aplicado via `configure()` em sessão existente, `requestId`
  reaproveitado de intenção commitada (reenvio após crash não duplica input),
  bootstrap fecha storage/Harness quando um passo falha.
- Container: `GEMINI_API_KEY` encaminhada, `--userns=keep-id` no podman
  rootless, recusa de root, teste da execução real do wrapper.
- Teste de crash pelo caminho do agente (`test/crash-agent.test.ts`): SIGKILL
  dentro da geração, mesmo prompt repetido, uma única entrada `pi.user`.
- Auditoria do M0 considerada fechada; itens em aberto passam ao M1.

## Config do agente

`~/.config/durable-pi/config.json` (ou `$XDG_CONFIG_HOME/...`, ou
`DURABLE_PI_AGENT_CONFIG`) define o modelo padrão: `{"model": "provider/modelo"}`.
Ordem de resolução: `--model` → `DURABLE_PI_MODEL` → config → erro de uso.
`--model` não é pegajoso: o modelo gravado na sessão é o último aplicado, nunca
o default da próxima execução. Exemplo em `docs/agent-config.example.json`.

## Auditoria do M1.0

`docs/audits/2026-10-22-m1-0.md` (gpt-6.1-sol, thinking high). Dez achados
confirmados, nenhum refutado. Ordem de correção escolhida:

1. Recuperação só vale no mesmo banco: CLI sem `--session`/`-c` cria id novo.
2. Lock com corrida na janela `open(wx)`→`writeFile` e PID que não identifica
   dono entre containers (`EPERM` lido como morte).
3. `cwd` interno (`/workspace`) não distingue dois projetos no container.
4. Janela entre limpar a intenção e imprimir a resposta.
5. Uma intenção implícita só; `randomUUID()` dentro do callback de commit;
   bootstrap não fecha o Harness em falha de `agent()`/`configure()`.
6. Invariante 1 da spec do handoff confunde admissão com colocação (`queued`).
7. Helper de `chown` do run.sh sem `keep-id` no podman rootless.

## Fechamento do M1.0

Corrigido depois da auditoria (`docs/audits/2026-10-22-m1-0.md`):

- lock por unix socket (`<db>.sock`), sem PID e imune a namespace;
- identidade de workspace no host (`DURABLE_PI_WORKSPACE`), com recusa de
  retomada em outro projeto mesmo com `cwd` igual;
- `--env-file` no lugar de `-e NAME`: o wslc ignorava `-e` sem valor, então
  nenhuma variável chegava ao container (nem chave de API, nem workspace);
- `app.control` v2 com lista de intenções (teto 8) e `migrate` da v1;
- `randomUUID()` fora do commit, bootstrap fechando o Harness em qualquer
  falha, `chown` fora do caminho podman rootless;
- CLI imprime `sessão: <id>` em falha: recuperação exige `--session`/`-c`;
- spec do handoff corrigida (admissão ≠ colocação; handle morre com o
  Harness) e testes do muse regerados.

## Pendências

- **Push a partir do container** (M3). Decidido em 2026-10-22: sem credencial
  de `git` dentro do container; o agente commita e o push é feito no host.
  Quando push automático for requisito, o caminho é um proxy de credencial no
  host via socket, para o token nunca entrar no container.

- **Gate de `test/spec/` no CI** (adiado por decisão, 2026-10-22). O objetivo é
  falhar o PR quando um arquivo de `test/spec/` muda no mesmo diff da
  implementação, para que o teste de contrato não seja ajustado ao código.
  Antes de implementar, resolver: como distinguir correção legítima de spec
  (spec atualizada + teste regenerado) de teste acomodado; e se o gate compara
  diff do PR ou exige que `test/spec/` venha em commit separado.

## Feito

- Repositório público, CI em PR, ruleset em `main` (PR obrigatório, `gates`
  exigido) e secret scanning com push protection.
- `AGENTS.md` com o modelo de teste e a regra do overlay de `tx.doc()`.
- `test/crash-charge.test.ts`: `SIGKILL` dentro do provedor de `chargeOnce`;
  regerar a chave no resume quebra 2 dos 3 casos.
- M0 em `main`: núcleo do agente, CLI `-p`, build e imagem.
- Imagem validada no WSL com `wslc` 3.0.3.0: build, volume nomeado, bind do
  `cwd` e sessão SQLite persistida no volume. O caminho Docker usa o mesmo
  `scripts/run.sh` e não foi exercitado aqui.

## Bloqueios

Nenhum.
