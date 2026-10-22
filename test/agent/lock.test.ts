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
	it("recusa um segundo dono enquanto o processo está vivo", async () => {
		await withDb(async (dbPath) => {
			const lock = await acquireStorageLock(dbPath);
			await expect(acquireStorageLock(dbPath)).rejects.toThrow(
				/em uso pelo processo/,
			);
			await lock.release();
		});
	});

	it("libera o banco depois do release", async () => {
		await withDb(async (dbPath) => {
			const first = await acquireStorageLock(dbPath);
			await first.release();

			const second = await acquireStorageLock(dbPath);
			await second.release();
		});
	});

	it("toma lock órfão de processo que não existe mais", async () => {
		await withDb(async (dbPath) => {
			// PID que não existe: crash deixou o arquivo para trás.
			await writeFile(`${dbPath}.lock`, "999999\n");

			const lock = await acquireStorageLock(dbPath);

			expect(lock.path).toBe(`${dbPath}.lock`);
			await lock.release();
		});
	});
});
