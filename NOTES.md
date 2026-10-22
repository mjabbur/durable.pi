# NOTES

Achados sobre o código do Pi e do pi-durable. Formato: `path:linha` + o que
foi verificado. Não guarde aqui o que já está em `docs/DURABILITY.md`.

## Ambiente

- Versões instaladas: `npm ls @earendil-works/pi-durable @earendil-works/pi-ai`
- Pi CLI: `pi --version`

## Achados

<!-- - node_modules/@earendil-works/pi-durable/dist/harness/harness.d.ts:12 — Harness.open assinatura -->

## Achados

- Valores lidos de `tx.doc()` não podem sair do commit: o draft vira overlay e
  falha com "Cannot use a settled overlay". Copie para objeto comum antes de
  retornar.

## Perguntas abertas

- Como `pi.generation` decide reenviar `pi.system` quando o prompt muda?
- Qual o custo real de compaction em storage SQLite (tamanho por checkpoint)?

## Decisões

| Data | Decisão | Motivo |
|---|---|---|
| 2026-10-22 | Testes de spec gerados por `muse-spark-1.3-contributor` | 3 de 3 completaram em ~1 min; 2 de 2 compilam após fixar o subpath de `BACKGROUND_CONTEXT`; 8 de 9 testes passam contra `src/counter.ts` |
| 2026-10-22 | `mimo-v2.6-flash` fora do bake-off | 3 execuções seguidas sem escrever arquivo, mesmo com 600s; funcionou uma vez e parou |
| 2026-10-22 | `--thinking low` como padrão | n=3 por nível: mutação 4,0-4,3 de 9 e baseline 1-2 falhas em todos; `low` mediana 86s contra 148s do `high` |
| 2026-10-22 | Runtime Node 24, sem Bun | Invariantes de durabilidade verificados sobre `node:sqlite`; Bun exigiria adaptador e revalidação |
| 2026-10-22 | Bake-off mede artefato, não `pi_exit` | `pi_exit 124` apareceu em run com arquivo completo e compilando; só o teste gerado e o `tsc` decidem |
| 2026-10-22 | Tier `contributor` aceito | O desenvolvimento será aberto; política de dados do provedor não é restrição aqui |

## Pendências

- [x] `npm install`
- [x] testes de spec vermelhos e implementação verde (`specs/counter`)
- [x] teste de crash real com `SIGKILL` (`test/crash.test.ts`)
- [x] idempotência para provedor sem API de consulta (`src/charge.ts`, intenção + chave)
- [ ] crash em processo filho exercitando `chargeOnce` (hoje o crash usa uma task do fixture)

## Testes do handoff (gerados pelo muse)

- `specs/handoff/spec.md` descreve o contrato de `submit`/`watch`/`ask`; o teste
  `test/agent/handoff.muse.test.ts` foi escrito por
  `opencode-go/muse-spark-1.3-contributor` (thinking low) em cópia isolada do
  repo, sem editar `src/`.
- Duas falhas na primeira rodada eram **defeito da spec**, não do código:
  - invariante 4 exigia duas entradas `pi.user` adjacentes; a fila coloca a
    resposta entre elas. Corrigido para contagem, sem ordem.
  - invariante 9 reusava o handle de `Submission` depois de `closeAgent()`; o
    handle morre com o Harness (`Session is closed`). Corrigido: handoff é por
    `requestId`, handle não atravessa processo.
- Segunda rodada: 10/10 verdes, sem edição manual do teste gerado.
