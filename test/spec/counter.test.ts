import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createSession,
	MemoryStorage,
	type ConversationId,
	type Session,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { bumpOnce, readCount } from "../../src/counter.js";

function newSession(): Session {
	return createSession(new MemoryStorage());
}

async function newConversation(session: Session): Promise<ConversationId> {
	const record = await session.commit(
		(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
		BACKGROUND_CONTEXT,
	);
	return record.id;
}

describe("bumpOnce / readCount — spec.md", () => {
	it("Comportamento 1: primeira chamada com requestId inédito incrementa 1 e devolve o novo valor", async () => {
		const session = newSession();
		const conversationId = await newConversation(session);

		const value = await bumpOnce(session, conversationId, "req-1", BACKGROUND_CONTEXT);

		expect(value).toBe(1);
	});

	it("Comportamento 2: repetir o mesmo requestId devolve o mesmo valor e não incrementa", async () => {
		const session = newSession();
		const conversationId = await newConversation(session);

		const first = await bumpOnce(session, conversationId, "req-1", BACKGROUND_CONTEXT);
		const second = await bumpOnce(session, conversationId, "req-1", BACKGROUND_CONTEXT);

		expect(second).toBe(first);
		expect(await readCount(session, conversationId, BACKGROUND_CONTEXT)).toBe(1);
	});

	it("Comportamento 3: requestIds diferentes incrementam um cada", async () => {
		const session = newSession();
		const conversationId = await newConversation(session);

		expect(await bumpOnce(session, conversationId, "req-a", BACKGROUND_CONTEXT)).toBe(1);
		expect(await bumpOnce(session, conversationId, "req-b", BACKGROUND_CONTEXT)).toBe(2);
		expect(await bumpOnce(session, conversationId, "req-c", BACKGROUND_CONTEXT)).toBe(3);
		expect(await readCount(session, conversationId, BACKGROUND_CONTEXT)).toBe(3);
	});

	it("Comportamento 4: chamadas concorrentes com requestIds diferentes não perdem incremento", async () => {
		const session = newSession();
		const conversationId = await newConversation(session);
		const requestIds = Array.from({ length: 8 }, (_, i) => `req-${i}`);

		const results = await Promise.all(
			requestIds.map((requestId) =>
				bumpOnce(session, conversationId, requestId, BACKGROUND_CONTEXT),
			),
		);

		expect([...results].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(await readCount(session, conversationId, BACKGROUND_CONTEXT)).toBe(8);
	});

	it("Comportamento 5: chamadas concorrentes com o mesmo requestId incrementam uma única vez", async () => {
		const session = newSession();
		const conversationId = await newConversation(session);

		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				bumpOnce(session, conversationId, "req-same", BACKGROUND_CONTEXT),
			),
		);

		for (const value of results) {
			expect(value).toBe(1);
		}
		expect(await readCount(session, conversationId, BACKGROUND_CONTEXT)).toBe(1);
	});

	it("Comportamento 6: readCount devolve 0 quando nunca houve incremento", async () => {
		const session = newSession();
		const conversationId = await newConversation(session);

		expect(await readCount(session, conversationId, BACKGROUND_CONTEXT)).toBe(0);
	});

	it("Comportamento 7: readCount reflete apenas estado commitado, nunca escrita em andamento", async () => {
		const session = newSession();
		const conversationId = await newConversation(session);

		// O incremento segue em andamento; a leitura concorrente só pode ver o último
		// estado commitado, nunca um meio-termo da escrita em curso.
		const inFlight = bumpOnce(session, conversationId, "req-1", BACKGROUND_CONTEXT);
		const observed = await readCount(session, conversationId, BACKGROUND_CONTEXT);
		expect([0, 1]).toContain(observed);

		// Depois que o incremento resolve, o valor contado já é visível.
		const counted = await inFlight;
		expect(await readCount(session, conversationId, BACKGROUND_CONTEXT)).toBe(counted);

		// Invariante mais forte: nenhuma leitura observa um valor acima do comprometido.
		expect(counted).toBe(1);
		expect(observed).toBeLessThanOrEqual(counted);
	});

	it("Comportamento 8: conversas diferentes têm contadores independentes", async () => {
		const session = newSession();
		const conversationA = await newConversation(session);
		const conversationB = await newConversation(session);

		expect(await bumpOnce(session, conversationA, "shared-req", BACKGROUND_CONTEXT)).toBe(1);
		expect(await bumpOnce(session, conversationB, "shared-req", BACKGROUND_CONTEXT)).toBe(1);
		expect(await bumpOnce(session, conversationA, "other-req", BACKGROUND_CONTEXT)).toBe(2);

		expect(await readCount(session, conversationA, BACKGROUND_CONTEXT)).toBe(2);
		expect(await readCount(session, conversationB, BACKGROUND_CONTEXT)).toBe(1);
	});
});
