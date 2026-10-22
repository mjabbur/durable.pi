# PROGRESS

## Estado

- Gates verdes: typecheck, lint e 24 testes (3 invariante, 8 counter, 9 charge,
  4 crash).
- `src/counter.ts` e `src/charge.ts` implementados contra as specs.
- Bake-off fechado: `muse-spark-1.3-contributor`, `--thinking low`, medida por
  artefato.
- Repositório inicializado; nenhuma API pública exportada ainda.

## Decisões

Ver tabela em `NOTES.md`. Em resumo: Node 24, sem Bun; pi-durable fixado em
1.4.0; testes derivados da spec por agente separado; `low` como nível de
raciocínio.

## Próximos passos

1. Crash test em processo filho exercitando `chargeOnce` real, não só a task do
   fixture.
2. Decidir se `test/spec/` vira gate de CI (falha o PR se o teste for editado
   durante a implementação).
3. `src/index.ts` e mapa `exports` se o projeto virar biblioteca.
4. Regra do overlay de `tx.doc()` no `AGENTS.md`.

## Bloqueios

Nenhum.
