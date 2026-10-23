import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { chargeOnce, type ChargeProvider } from "../src/charge.js";

const ctx = BACKGROUND_CONTEXT;

/** Provedor que falha a primeira vez: a intenção fica sem resultado. */
function failingProvider(): ChargeProvider & { calls: number } {
	const provider = {
		calls: 0,
		charge(key: string, amountCents: number) {
			provider.calls += 1;
			if (provider.calls === 1) {
				return Promise.reject(new Error("recusado"));
			}
			return Promise.resolve({ key, amountCents });
		},
	};
	return provider;
}

describe("chargeOnce: intenção já gravada", () => {
	it("recusa valor diferente sem sobrescrever a intenção original", async () => {
		const session = createSession(new MemoryStorage());
		const conversationId = await session
			.commit(
				(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
				ctx,
			)
			.then((record) => record.id);
		const provider = failingProvider();

		await expect(
			chargeOnce(session, conversationId, "pedido-1", 1_000, provider, ctx),
		).rejects.toThrow("recusado");

		await expect(
			chargeOnce(session, conversationId, "pedido-1", 2_000, provider, ctx),
		).rejects.toThrow(/já tem intenção de 1000 centavos/);
		expect(provider.calls).toBe(1);
	});
});
