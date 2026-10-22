import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { acquireStorageLock } from "../../src/agent/lock.js";

async function withDb(run: (dbPath: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "durable-lock-"));
	try {
		await run(join(dir, "session.sqlite"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("acquireStorageLock", () => {
	it("recusa um segundo dono enquanto o primeiro escuta", async () => {
		await withDb(async (dbPath) => {
			const lock = await acquireStorageLock(dbPath);
			await expect(acquireStorageLock(dbPath)).rejects.toThrow(
				/em uso por outro processo/,
			);
			await lock.release();
		});
	});

	it("libera o banco depois do release", async () => {
		await withDb(async (dbPath) => {
			const first = await acquireStorageLock(dbPath);
			await first.release();

			const second = await acquireStorageLock(dbPath);
			expect(second.path).toBe(`${dbPath}.sock`);
			await second.release();
		});
	});

	it("toma o socket órfão de processo que morreu", async () => {
		await withDb(async (dbPath) => {
			// Arquivo comum no lugar do socket: `connect()` recusa, como num crash.
			await writeFile(`${dbPath}.sock`, "");

			const lock = await acquireStorageLock(dbPath);

			expect(lock.path).toBe(`${dbPath}.sock`);
			await lock.release();
		});
	});

	it("vários concorrentes: só um ganha", async () => {
		await withDb(async (dbPath) => {
			const results = await Promise.allSettled([
				acquireStorageLock(dbPath),
				acquireStorageLock(dbPath),
				acquireStorageLock(dbPath),
			]);

			const ganhos = results.filter(
				(result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireStorageLock>>> =>
					result.status === "fulfilled",
			);
			expect(ganhos.length).toBe(1);
			await ganhos[0]?.value.release();
		});
	});
});
