# durable.pi

Agentes duráveis em Node/TypeScript sobre [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).
Experimental: o comportamento acompanha a versão fixada no `package.json`.

O princípio do projeto: estado é o que foi commitado; memória é cache. Todo
efeito externo é precedido de intenção durável e reconciliado por chave.

## Requisitos

Node 24 (`>=22`) e npm. A versão de referência está em `.nvmrc`.

## Comandos

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run test        # vitest
```

Pronto = os três verdes. O CI roda a mesma sequência.

## Estrutura

| Caminho | Papel |
|---|---|
| `src/` | implementação (`counter`, `charge`) |
| `specs/<slug>/spec.md` | contrato de efeitos e comportamento numerado |
| `test/spec/` | testes derivados da spec, um por comportamento |
| `test/invariants.test.ts` | atomicidade, persistência, serialização |
| `test/crash.test.ts` | `SIGKILL` em processo filho, sem efeito duplicado |
| `docs/DURABILITY.md` | por que cada invariante existe |
| `docs/RUNBOOK.md` | sintoma, diagnóstico e ação em produção |
| `docs/PI-CODE-MAP.md` | mapa do código do Pi e do pi-durable |
| `docs/ROADMAP.md` | marco do Pi durável: CLI, servidor e web |
| `bakeoff/` | bancada que gera testes a partir da spec |
| `scripts/` | automação da bancada |

## Fluxo

1. Escreva `specs/<slug>/spec.md` com o contrato de efeitos: chave de
   idempotência, onde é gravada, o que acontece em cada ponto de crash.
2. Gere os testes a partir da spec, sem acesso a `src/`, e adote em
   `test/spec/` depois de revisar.
3. Implemente em `src/` até os testes ficarem verdes.
4. Se a mudança toca falha, acrescente invariante ou crash test.

Desvio da spec atualiza a spec no mesmo PR.

## Bake-off

```bash
scripts/bakeoff.sh opencode-go/muse-spark-1.3-contributor charge
```

Roda em diretório isolado, mede artefato (`wrote_test`, `tsc_exit`, citações) e
grava em `bakeoff/runs/<modelo>/<spec>/run-N/`. Modelo e critérios em
`bakeoff/models.txt` e `NOTES.md`.

## Licença

MIT. Veja [LICENSE](LICENSE).
