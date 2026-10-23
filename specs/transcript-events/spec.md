# reducer do transcript ao vivo

| Campo | Valor |
|---|---|
| Dono | `pi-durable-pi` |
| Status | aprovada |
| Versão do pi-durable | 1.4.0 |
| Specs relacionadas | `docs/audits/2026-10-22-m1-1.md` (achados 6 e 7) |

## Problema e resultado observável

O reducer da TUI implementava só parte do protocolo de `message_update` e podia
mostrar texto errado: bloco iniciado já preenchido era ignorado, substituição
não chegava à tela, e um slot `done` do snapshot apagava o resultado já lido.
Verificação: alimentar o reducer com eventos equivalentes e comparar com a
mensagem final.

## Contrato de efeitos

Nenhum efeito externo: funções puras sobre dados.

## Comportamento

1. `message_start` com mensagem que já traz conteúdo inicia o parcial com esse
   conteúdo (não zera).
2. `message_update` com `text_start`/`thinking_start` usa o `block` recebido
   como conteúdo inicial daquele `contentIndex`.
3. `message_update` com `block` substitui o bloco daquele `contentIndex`.
4. `message_update` com `message` substitui o parcial inteiro pela mensagem.
5. Deltas acumulam no `contentIndex` certo, na ordem recebida; `text` e
   `thinking` do parcial são a soma dos blocos, na ordem dos índices.
6. `message_end` remove o parcial e acrescenta o bloco final.
7. `tool_execution_update` com `{ trimStart, append }` corta o início atual
   antes de acrescentar; com `{ set }` substitui a saída. `trimStart` é relativo
   à janela do produtor (unidades UTF-16), não ao recorte de exibição.
8. `fromSnapshot` não sobrescreve resultado já lido: um slot `done` cujo
   resultado já está nas entradas não troca saída nem transforma erro em
   sucesso.
9. `fromSnapshot` mostra o parcial de `generation.message`.
10. `applyEvents` é puro: devolve estado novo e não muta o recebido.

## Falhas visíveis

Nenhuma: são funções puras. Entrada desconhecida é ignorada e o estado
permanece igual.

## API

```ts
import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";

export type Transcript = {
	readonly blocks: readonly TranscriptBlock[];
	readonly streaming: { text: string; thinking: string } | undefined;
	readonly seen: readonly string[];
	readonly queued: number;
	readonly running: boolean;
	readonly tokens: number;
};

export function emptyTranscript(): Transcript;
export function fromSnapshot(snapshot: SnapshotEvent): Transcript;
export function applyEvents(
	state: Transcript,
	events: readonly AgentEvent[],
): Transcript;
```

## Notas para o teste gerado

- Importe de `../src/tui/transcript.js`; `TranscriptBlock` também é exportado.
- Os tipos de evento são grandes: monte o mínimo e use `as SnapshotEvent` /
  `as AgentEvent` só onde o TypeScript exigir.
- Não dependa de campo interno além dos exportados acima.
- Evite `async` sem `await`; o lint do repositório roda no teste.
- `contentIndex` fora de ordem não é erro: o parcial ordena por índice.
- Substituição por `message` vale para o resto do lote: mudanças seguintes
  aplicam sobre ela.

## Critérios de aceitação

- [ ] cada teste cita o item de Comportamento correspondente
- [ ] nenhum teste depende de detalhe interno não exportado
- [ ] teste de slot `done` usa entrada de erro e saída não vazia
