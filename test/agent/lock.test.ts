import { spawn, type ChildProcess } from "node:child_process";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

/** Processo filho que segura o lock até ser morto. */
function holdUntilKilled(dbPath: string): Promise<ChildProcess> {
	const script = `
		import("node:sqlite").then(({ DatabaseSync }) => {
			const db = new DatabaseSync(${JSON.stringify(`${dbPath}.lock`)});
			db.exec("PRAGMA busy_timeout = 0");
			db.exec("BEGIN EXCLUSIVE");
			db.exec("CREATE TABLE IF NOT EXISTS owner (id INTEGER)");
			console.log("segurando");
			setInterval(() => {}, 1000);
		});
	`;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", script], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.once("data", () => resolve(child));
		child.once("error", reject);
	});
}

describe("acquireStorageLock", () => {
	it("recusa um segundo dono enquanto o primeiro está aberto", async () => {
		await withDb(async (dbPath) => {
			const lock = await acquireStorageLock(dbPath);
			await expect(acquireStorageLock(dbPath)).rejects.toThrow(
				/em uso por outro processo/,
			);
			await lock.release();
		});
	});

	it("recusa symlink e hardlink: o lock não distingue os nomes", async () => {
		await withDb(async (dbPath) => {
			await writeFile(dbPath, "");
			const alias = `${dbPath}.alias`;
			await symlink(dbPath, alias);
			await expect(acquireStorageLock(alias)).rejects.toThrow(/symlink/);

			const hard = `${dbPath}.hard`;
			await link(dbPath, hard);
			await expect(acquireStorageLock(hard)).rejects.toThrow(/hardlink/);
		});
	});

	it("libera o banco depois do release", async () => {
		await withDb(async (dbPath) => {
			const first = await acquireStorageLock(dbPath);
			await first.release();

			const second = await acquireStorageLock(dbPath);
			expect(second.path).toBe(`${dbPath}.lock`);
			await second.release();
		});
	});

	it("toma o lock de um processo que morreu", async () => {
		await withDb(async (dbPath) => {
			const child = await holdUntilKilled(dbPath);
			await expect(acquireStorageLock(dbPath)).rejects.toThrow(/em uso/);

			child.kill("SIGKILL");
			await new Promise((resolve) => child.once("exit", resolve));

			const lock = await acquireStorageLock(dbPath);
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
