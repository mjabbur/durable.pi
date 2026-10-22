# chargeOnce — cobrança com intenção durável

| Campo | Valor |
|---|---|
| Dono | a definir |
| Status | aprovada |
| Versão do pi-durable | 1.4.0 |
| Specs relacionadas | docs/DURABILITY.md §2, specs/counter |

## Problema e resultado observável

Cobrar uma vez por `requestId` mesmo quando o processo morre entre a chamada ao
provedor e o commit do resultado. Verificação: repetir o `requestId` após uma
falha não gera segunda cobrança.

## Contrato de efeitos

| Efeito externo | Idempotency key | Onde a chave é gravada | Checkpoint |
|---|---|---|---|
| `provider.charge(key, amountCents)` | gerada pela implementação, estável por `requestId` | intenção durável, antes da chamada | antes do efeito e depois do resultado |

O provedor é idempotente por chave: repetir a chave devolve o mesmo resultado e
não cobra de novo. O provedor **não** oferece consulta por chave.

## Replay

- Morre antes da chamada: a intenção existe, sem resultado; repetir usa a mesma
  chave e cobra uma vez.
- Morre depois da chamada, antes do commit do resultado: repetir usa a mesma
  chave; o provedor deduplica.
- Reenvio depois do resultado gravado: devolve o resultado, sem chamar o
  provedor.

## API

```ts
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Session } from "@earendil-works/pi-durable";

export interface ChargeProvider {
	charge(
		key: string,
		amountCents: number,
	): Promise<{ key: string; amountCents: number }>;
}

export interface ChargeResult {
	status: "charged";
	key: string;
	amountCents: number;
}

export async function chargeOnce(
	session: Session,
	conversationId: ConversationId,
	requestId: string,
	amountCents: number,
	provider: ChargeProvider,
	context: Context,
): Promise<ChargeResult>;

export async function readCharge(
	session: Session,
	conversationId: ConversationId,
	requestId: string,
	context: Context,
): Promise<ChargeResult | undefined>;
```

## Comportamento

1. Primeira chamada grava a intenção, chama o provedor uma vez com a chave e o
   valor, grava o resultado e devolve `{ status: "charged", key, amountCents }`.
2. Repetir o mesmo `requestId` com o mesmo valor devolve o resultado gravado e
   **não chama** o provedor.
3. Repetir o mesmo `requestId` com valor diferente rejeita e **não chama** o
   provedor.
4. Se o commit do resultado falhar depois da cobrança, a chamada rejeita; a
   próxima chamada com o mesmo `requestId` reusa a mesma chave, o provedor
   deduplica e o resultado é gravado. A cobrança efetiva continua uma.
5. Chamadas concorrentes com o mesmo `requestId` usam a mesma chave e resolvem
   com o mesmo resultado. O provedor pode ser chamado mais de uma vez; a
   cobrança efetiva é uma.
6. Erro do provedor propaga; nenhum resultado é gravado; repetir tenta de novo
   com a mesma chave.
7. `readCharge` devolve `undefined` antes do resultado e o resultado depois;
   nunca observa escrita em andamento.
8. Conversas diferentes com o mesmo `requestId` geram chaves diferentes e
   cobranças independentes.

## Falhas visíveis

Erro de storage é final. A chamada que encontra o erro rejeita com o **erro
original**; as chamadas seguintes rejeitam com `SessionFailed`.

## Critérios de aceitação

- [x] cada teste cita o item de Comportamento correspondente
- [x] teste usa provedor falso que registra chamadas e chaves
- [x] nenhum teste depende de nome de documento, kind de entry ou formato interno

## Fora de escopo

Reembolso, moeda, múltiplos provedores, conciliação por consulta (o provedor
não tem API de consulta).
