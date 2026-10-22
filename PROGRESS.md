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

1. Decidir se `test/spec/` vira gate de CI (falha o PR se o teste for editado
   durante a implementação).
2. `src/index.ts` e mapa `exports` se o projeto virar biblioteca.

## Feito

- Repositório público, CI em PR, ruleset em `main` (PR obrigatório, `gates`
  exigido) e secret scanning com push protection.
- `AGENTS.md` com o modelo de teste e a regra do overlay de `tx.doc()`.
- `test/crash-charge.test.ts`: `SIGKILL` dentro do provedor de `chargeOnce`;
  regerar a chave no resume quebra 2 dos 3 casos.

## Bloqueios

Nenhum.
