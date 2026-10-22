# bumpOnce — contador idempotente por conversa

| Campo | Valor |
|---|---|
| Dono | a definir |
| Status | aprovada |
| Versão do pi-durable | 1.4.0 |
| Specs relacionadas | docs/DURABILITY.md |

## Problema e resultado observável

Um input reprocessado não pode contar duas vezes. `bumpOnce` incrementa o
contador da conversa no máximo uma vez por `requestId`. Verificação: chamar
duas vezes com o mesmo `requestId` deixa o contador em 1.

## Contrato de efeitos

Nenhum efeito externo. O estado durável é um documento da conversa, commitado
na mesma transação da decisão de incrementar.

## Replay

- Morre antes do commit: nada foi contado.
- Morre depois do commit: a contagem existe e o `requestId` está registrado.
- Reenvio com o mesmo `requestId`: devolve o valor já contado, sem incrementar.

## API

```ts
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Session } from "@earendil-works/pi-durable";

export async function bumpOnce(
	session: Session,
	conversationId: ConversationId,
	requestId: string,
	context: Context,
): Promise<number>;

export async function readCount(
	session: Session,
	conversationId: ConversationId,
	context: Context,
): Promise<number>;
```

## Comportamento

1. Primeira chamada com `requestId` inédito incrementa 1 e devolve o novo valor.
2. Repetir o mesmo `requestId` devolve o mesmo valor e não incrementa.
3. `requestId` diferentes incrementam um cada.
4. Chamadas concorrentes com `requestId` diferentes não perdem incremento.
5. Chamadas concorrentes com o mesmo `requestId` incrementam uma única vez.
6. `readCount` devolve 0 quando nunca houve incremento.
7. `readCount` reflete apenas estado commitado, nunca escrita em andamento.
8. Conversas diferentes têm contadores independentes.

## Falhas visíveis

Erro de storage é final. A chamada que encontra o erro rejeita com o **erro
original**; as chamadas seguintes e os waits pendentes rejeitam com
`SessionFailed`. O chamador não retenta; nenhum teste deve assumir retry
automático.

## Critérios de aceitação

- [x] `test/spec/counter.test.ts` com `MemoryStorage`
- [x] cada teste cita o item de Comportamento correspondente
- [x] nenhum teste depende de nome de documento, kind de entry ou formato interno

## Fora de escopo

Tasks, compaction, efeito externo, persistência entre processos.
