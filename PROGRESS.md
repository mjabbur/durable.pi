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
