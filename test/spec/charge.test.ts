import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createSession,
	MemoryStorage,
	SessionFailed,
	type ConversationId,
	type Seq,
	type Session,
	type Storage,
	type StorageWrite,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { chargeOnce, readCharge } from "../../src/charge.js";
import type { ChargeProvider } from "../../src/charge.js";

const ctx: Context = BACKGROUND_CONTEXT;

class FakeProvider implements ChargeProvider {
	calls: Array<{ key: string; amountCents: number }> = [];
	effective = new Map<string, { key: string; amountCents: number }>();
	failWith: Error | undefined = undefined;

	charge(key: string, amountCents: number): Promise<{ key: string; amountCents: number }> {
		this.calls.push({ key, amountCents });
		if (this.failWith !== undefined) {
			const err = this.failWith;
			this.failWith = undefined;
			throw err;
		}
		const existing = this.effective.get(key);
		if (existing) return Promise.resolve({ ...existing });
		// Provedor idempotente por chave: repetir a chave não cobra de novo.
		const result = { key, amountCents };
		this.effective.set(key, result);
		return Promise.resolve({ ...result });
	}

	effectiveCharges(): number {
		return this.effective.size;
	}
}

async function setup() {
	const storage = new MemoryStorage();
	const session = createSession(storage);
	const conversationId = await session.commit(
		(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
		ctx,
	).then((r) => r.id);
	return { storage, session, conversationId };
}

function newSession(storage: Storage): Session {
	return createSession(storage);
}

describe("chargeOnce (spec chargeOnce)", () => {
	it("Comportamento 1: primeira chamada cobra uma vez e devolve {status,key,amountCents}", async () => {
		const { session, conversationId } = await setup();
		const provider = new FakeProvider();
		const result = await chargeOnce(session, conversationId, "req-1", 100, provider, ctx);
		expect(result.status).toBe("charged");
		expect(result.amountCents).toBe(100);
		expect(typeof result.key).toBe("string");
		expect(provider.calls).toHaveLength(1);
		expect(provider.calls[0]).toEqual({ key: result.key, amountCents: 100 });
		expect(provider.effectiveCharges()).toBe(1);
		await session.close(ctx);
	});

	it("Comportamento 2: repetir requestId com mesmo valor devolve gravado sem chamar provedor", async () => {
		const { session, conversationId } = await setup();
		const provider = new FakeProvider();
		const first = await chargeOnce(session, conversationId, "req-2", 200, provider, ctx);
		const callsAfterFirst = provider.calls.length;
		const second = await chargeOnce(session, conversationId, "req-2", 200, provider, ctx);
		expect(second).toEqual(first);
		expect(provider.calls).toHaveLength(callsAfterFirst);
		await session.close(ctx);
	});

	it("Comportamento 3: repetir requestId com valor diferente rejeita sem chamar provedor", async () => {
		const { session, conversationId } = await setup();
		const provider = new FakeProvider();
		await chargeOnce(session, conversationId, "req-3", 100, provider, ctx);
		const calls = provider.calls.length;
		await expect(chargeOnce(session, conversationId, "req-3", 999, provider, ctx)).rejects.toThrow();
		expect(provider.calls).toHaveLength(calls);
		await session.close(ctx);
	});

	it("Comportamento 4: após reinício (crash entre cobrança e commit) reusa a mesma chave e cobra uma vez efetiva", async () => {
		const storage = new MemoryStorage();
		const session1 = createSession(storage);
		const conversationId: ConversationId = await session1
			.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), ctx)
			.then((r) => r.id);
		const provider = new FakeProvider();
		const first = await chargeOnce(session1, conversationId, "req-4", 150, provider, ctx);
		// Simula morte do processo: descarta a sessão e reabre sobre o mesmo storage.
		const session2 = newSession(storage);
		provider.calls.length = 0; // só conta chamadas pós-reinício
		const second = await chargeOnce(session2, conversationId, "req-4", 150, provider, ctx);
		expect(second).toEqual(first);
		// Reenvio depois do resultado gravado não cobra de novo (Replay §3).
		expect(provider.effectiveCharges()).toBe(1);
		await session1.close(ctx);
		await session2.close(ctx);
	});

	it("Comportamento 5: concorrentes com mesmo requestId resolvem igual com uma cobrança efetiva", async () => {
		const { session, conversationId } = await setup();
		const provider = new FakeProvider();
		const [a, b] = await Promise.all([
			chargeOnce(session, conversationId, "req-5", 300, provider, ctx),
			chargeOnce(session, conversationId, "req-5", 300, provider, ctx),
		]);
		expect(a).toEqual(b);
		expect(a.status).toBe("charged");
		// Provedor pode ser chamado >1x, mas a cobrança efetiva (por chave) é uma.
		expect(provider.effectiveCharges()).toBe(1);
		await session.close(ctx);
	});

	it("Comportamento 6: erro do provedor propaga, nada é gravado e repetição com mesma chave tenta de novo", async () => {
		const { session, conversationId } = await setup();
		const provider = new FakeProvider();
		provider.failWith = new Error("provider down");
		await expect(chargeOnce(session, conversationId, "req-6", 400, provider, ctx)).rejects.toThrow(
			"provider down",
		);
		expect(await readCharge(session, conversationId, "req-6", ctx)).toBeUndefined();
		const keysBefore = provider.calls.map((c) => c.key);
		const ok = await chargeOnce(session, conversationId, "req-6", 400, provider, ctx);
		expect(ok.status).toBe("charged");
		// Mesma chave estável por requestId.
		expect(provider.calls[provider.calls.length - 1]!.key).toBe(keysBefore[0]);
		expect(provider.effectiveCharges()).toBe(1);
		await session.close(ctx);
	});

	it("Comportamento 7: readCharge é undefined antes e devolve resultado depois", async () => {
		const { session, conversationId } = await setup();
		const provider = new FakeProvider();
		expect(await readCharge(session, conversationId, "req-7", ctx)).toBeUndefined();
		const charged = await chargeOnce(session, conversationId, "req-7", 500, provider, ctx);
		expect(await readCharge(session, conversationId, "req-7", ctx)).toEqual(charged);
		await session.close(ctx);
	});

	it("Comportamento 8: conversas diferentes com mesmo requestId geram chaves e cobranças independentes", async () => {
		const { session } = await setup();
		const convA: ConversationId = await session
			.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), ctx)
			.then((r) => r.id);
		const convB: ConversationId = await session
			.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), ctx)
			.then((r) => r.id);
		const provider = new FakeProvider();
		const a = await chargeOnce(session, convA, "req-same", 100, provider, ctx);
		const b = await chargeOnce(session, convB, "req-same", 100, provider, ctx);
		expect(a.key).not.toBe(b.key);
		expect(provider.effectiveCharges()).toBe(2);
		expect(await readCharge(session, convA, "req-same", ctx)).toEqual(a);
		expect(await readCharge(session, convB, "req-same", ctx)).toEqual(b);
		await session.close(ctx);
	});

	it("Falhas visíveis: erro de storage rejeita com erro original e seguintes com SessionFailed", async () => {
		const boom = new Error("disk gone");
		// O primeiro commit cria a conversa; a falha é injetada no segundo, que é
		// o commit da intenção dentro de chargeOnce.
		class FlakyStorage extends MemoryStorage {
			commits = 0;
			override async commit(
				writes: readonly StorageWrite[],
				context: Context,
			): Promise<Seq> {
				this.commits += 1;
				if (this.commits === 2) throw boom;
				return super.commit(writes, context);
			}
		}
		const session = createSession(new FlakyStorage());
		const conversationId: ConversationId = await session
			.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), ctx)
			.then((r) => r.id);
		const provider = new FakeProvider();
		await expect(
			chargeOnce(session, conversationId, "req-fail", 100, provider, ctx),
		).rejects.toBe(boom);
		await expect(
			chargeOnce(session, conversationId, "req-fail-2", 100, provider, ctx),
		).rejects.toBeInstanceOf(SessionFailed);
	});
});
