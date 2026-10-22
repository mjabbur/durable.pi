# AGENTS.md

Node 24, ESM, TypeScript. `@earendil-works/pi-durable` 1.4.0, API experimental:
confira `node_modules/@earendil-works/pi-durable/dist/*.d.ts` antes de usar.
Detalhes em `docs/DURABILITY.md` e `docs/PI-CODE-MAP.md`.

## Comandos

- `npm run typecheck`, `npm run test`, `npm run lint`. Pronto = os três
  verdes.

## Durabilidade (não negociável)

- Callback de commit é puro: só `tx.entry()` e `tx.doc()`. Sem I/O, rede, relógio, log.
- Efeito externo só em fase de task: grave intenção + idempotency key, chame,
  grave resultado. No resume, consulte a chave antes de repetir.
- `requestId` estável; entrega é ao menos uma vez. Estado é o commit, memória
  é cache.
- Determinístico entre checkpoints: `Date.now()`, `Math.random()`, `process.env`
  e fetch não registrados não entram em prompt nem em decisão.
- `Context` do Chord é por chamada; não guarde nem reuse após settle.
- `defineDoc` sempre com `version`, `history` e `checkpointWhen`.
- Um processo por storage. `MemoryStorage` em teste, SQLite em produção.
- Valor lido de `tx.doc()` não sai do commit: copie os campos para objeto novo
  (o draft vira overlay e falha depois do settle).

## Testes

- Contrato vem de `specs/`: `test/spec/` é gerado por agente separado
  (`muse-spark-1.3-contributor`, `--thinking low`), que lê só a spec.
- Não edite `test/spec/` durante a implementação. Teste errado se corrige na
  spec e regenera; o teste não se ajusta ao código.

## Falhas

- Erro de storage encerra o Harness: escute `harness.closed`, não retente
  `commit`; reabra e reenvie com o mesmo `requestId`.
- `ConversationBusy` e `ReadAfterWrite` são fluxo normal, não bug.
- Todo `await` novo que cruza I/O exige teste de crash (matar e reabrir).

## TypeScript

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` ligados.
- Sem `any`; sem `as` para silenciar. Borda externa: `unknown` + schema.
- Tools via `defineTool` (TypeBox). `import type`; ESM com `.js`; sem barrel.

## Código do Pi

Mapa e ordem de leitura: `docs/PI-CODE-MAP.md`. `rg` pelo símbolo antes de
abrir arquivo; `dist/*.d.ts` é a API real da versão instalada. Achados vão para
`NOTES.md` com `path:linha`, não para o chat.

## Escopo

Diff mínimo; sem refatorar fora do pedido; dependência nova: pergunte.
`PROGRESS.md` com estado, decisões e próximos passos.

<!-- memd-projeto:inicio -->
## Memoria compartilhada (memd)
- Wrapper deste projeto: `memd-pi-durable-pi`. Ao abrir ou retomar a sessao: `memd-pi-durable-pi --skill` e `memd-pi-durable-pi resume`.
- Escopo dos registros: `durable.pi/<area>`. Fora dele o memd recusa.
- Para a extensao de commit do Pi: `source .memd-projeto.env` (define MEMD_WRAPPER) antes de abrir o Pi.
<!-- memd-projeto:fim -->
