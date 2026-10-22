import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createSession,
	defineEntry,
	MemoryStorage,
	type ConversationId,
	type Session,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";

// Invariantes de docs/DURABILITY.md cobertos aqui:
//   1. commit atômico (callback que lança não grava nada)
//   2. estado commitado sobrevive a reabrir o storage
//   3. commits concorrentes serializam sem perder entrada
// Pendentes, exigem processo filho e task: idempotência de efeito externo,
// determinismo entre checkpoints, dedupe por requestId, falha de storage.

const Note = defineEntry<{ text: string }>("test.note");
const ctx = BACKGROUND_CONTEXT;
const open = new Set<Session>();
const tempDirs: string[] = [];

function track<T extends Session>(session: T): T {
	open.add(session);
	return session;
}

async function newConversation(session: Session) {
	return session.commit(
		(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
		ctx,
	);
}

async function entryKinds(session: Session, conversationId: ConversationId) {
	const page = await session.commit(
		(tx) => tx.scanEntries({ conversationId, order: "ascending" }, 50),
		ctx,
	);
	return page.items.map((entry) => entry.kind);
}

afterEach(async () => {
	for (const session of open) {
		await session.close(ctx).catch(() => undefined);
	}
	open.clear();
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("invariantes de durabilidade", () => {
	it("commit que lança não grava nada", async () => {
		const session = track(createSession(new MemoryStorage()));
		const conversation = await newConversation(session);

		await expect(
			session.commit(async (tx) => {
				await tx.appendEntry(Note, conversation.id, { data: { text: "perdida" } });
				throw new Error("falha depois do append");
			}, ctx),
		).rejects.toThrow("falha depois do append");

		expect(await entryKinds(session, conversation.id)).toEqual([]);
	});

	it("entry commitada sobrevive a reabrir o storage", async () => {
		const dir = await mkdtemp(join(tmpdir(), "durable-pi-"));
		tempDirs.push(dir);
		const file = join(dir, "session.sqlite");

		const first = track(createSession(await openNodeSqliteStorage(file)));
		const conversation = await newConversation(first);
		await first.commit(
			(tx) => tx.appendEntry(Note, conversation.id, { data: { text: "sobrevive" } }),
			ctx,
		);
		await first.close(ctx);
		open.delete(first);

		const second = track(createSession(await openNodeSqliteStorage(file)));
		const page = await second.commit(
			(tx) => tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 50),
			ctx,
		);

		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.data).toEqual({ text: "sobrevive" });
	});

	it("commits concorrentes serializam sem perder entrada", async () => {
		const session = track(createSession(new MemoryStorage()));
		const conversation = await newConversation(session);

		const [a, b] = await Promise.all([
			session.commit(
				(tx) => tx.appendEntry(Note, conversation.id, { data: { text: "a" } }),
				ctx,
			),
			session.commit(
				(tx) => tx.appendEntry(Note, conversation.id, { data: { text: "b" } }),
				ctx,
			),
		]);

		expect(a.id).not.toBe(b.id);
		expect(await entryKinds(session, conversation.id)).toEqual(["test.note", "test.note"]);
	});
});
