import type { Context } from "@earendil-works/chord";
import {
	defineDoc,
	type ConversationId,
	type Session,
} from "@earendil-works/pi-durable";

/**
 * Contador por conversa com dedupe por requestId.
 *
 * `seen` guarda requestId -> valor contado, então repetir o mesmo id devolve o
 * valor original mesmo depois de outros incrementos. O commit é a única
 * escrita: idempotência, concorrência e atomicidade vêm da linha de mutação.
 */
const Counters = defineDoc<{ count: number; seen: Record<string, number> }>({
	kind: "app.counter",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ count: 0, seen: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 512,
});

export async function bumpOnce(
	session: Session,
	conversationId: ConversationId,
	requestId: string,
	context: Context,
): Promise<number> {
	return session.commit(async (tx) => {
		const counters = await tx.doc(Counters, conversationId);
		const seen = counters.seen[requestId];
		if (seen !== undefined) return seen;

		const next = counters.count + 1;
		counters.count = next;
		counters.seen[requestId] = next;
		return next;
	}, context);
}

export async function readCount(
	session: Session,
	conversationId: ConversationId,
	context: Context,
): Promise<number> {
	const snapshot = await session.snapshot(Counters, conversationId, context);
	return snapshot?.count ?? 0;
}
