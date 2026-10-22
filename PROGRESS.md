# PROGRESS

## Estado

- Gates verdes: typecheck, lint e 27 testes (3 invariante, 8 counter, 9 charge,
  4 crash de fixture, 3 crash de `chargeOnce`).
- `src/counter.ts` e `src/charge.ts` implementados contra as specs.
- Bake-off fechado: `muse-spark-1.3-contributor`, `--thinking low`, medida por
  artefato.
- Repositório inicializado; nenhuma API pública exportada ainda.

## Decisões

Ver tabela em `NOTES.md`. Em resumo: Node 24, sem Bun; pi-durable fixado em
1.4.0; testes derivados da spec por agente separado; `low` como nível de
raciocínio.

## Próximos passos

Marco atual: `docs/ROADMAP.md`. M0 (CLI `-p` com sessão durável) é o primeiro
passo; `src/index.ts` e mapa `exports` só quando o projeto virar biblioteca.

## Pendências

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
