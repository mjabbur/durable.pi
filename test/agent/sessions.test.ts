import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	assertSessionId,
	InvalidSessionIdError,
	latestSession,
	listSessions,
} from "../../src/agent/sessions.js";

async function withDir(run: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "durable-sessions-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function touch(path: string, at: Date) {
	await writeFile(path, "");
	await utimes(path, at, at);
}

describe("listSessions", () => {
	it("ignora diretórios e arquivos que não são sessão", async () => {
		await withDir(async (dir) => {
			await touch(join(dir, "20260101T000000-aaaaaa.sqlite"), new Date(1000));
			await mkdir(join(dir, "20260102T000000-bbbbbb.sqlite"));
			await writeFile(join(dir, "notas.txt"), "");

			const sessions = await listSessions(dir);

			expect(sessions.map((session) => session.id)).toEqual([
				"20260101T000000-aaaaaa",
			]);
		});
	});

	it("ordena pela atividade mais recente, incluindo o WAL", async () => {
		await withDir(async (dir) => {
			const antiga = join(dir, "20260101T000000-aaaaaa.sqlite");
			const nova = join(dir, "20260102T000000-bbbbbb.sqlite");
			await touch(antiga, new Date(1000));
			await touch(nova, new Date(2000));
			// Commit recente só no WAL: o banco principal continua "antigo".
			await touch(`${antiga}-wal`, new Date(3000));

			const sessions = await listSessions(dir);

			expect(sessions[0]?.id).toBe("20260101T000000-aaaaaa");
			expect((await latestSession(dir))?.id).toBe("20260101T000000-aaaaaa");
		});
	});

	it("devolve lista vazia para diretório ausente", async () => {
		await withDir(async (dir) => {
			expect(await listSessions(join(dir, "nao-existe"))).toEqual([]);
		});
	});
});

describe("assertSessionId", () => {
	it("aceita ids do formato gerado", () => {
		expect(() => assertSessionId("20260101T000000-aaaaaa")).not.toThrow();
	});

	it("recusa travessia de caminho", () => {
		expect(() => assertSessionId("../fora")).toThrow(InvalidSessionIdError);
	});
});
