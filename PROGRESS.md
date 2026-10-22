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

## Pendências

- **Credencial de `git` no container** (decidir com o usuário, 2026-10-22).
  `git push` dentro do container exige token restrito ao repo ou socket SSH
  montado; montar `SSH_AUTH_SOCK` devolve ao agente a chave para qualquer host.
  Alternativa mínima: só commits locais até a decisão.
- **Imagem não validada nesta máquina** (2026-10-22). Não há `docker` nem
  `podman` no ambiente onde o M0 foi escrito; `Dockerfile` e `scripts/run.sh`
  foram escritos mas nunca executados. Validar com
  `docker build -t durable-pi:dev . && scripts/run.sh -p "..."` antes de
  considerar o M0 fechado.

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

## Bloqueios

Nenhum.
