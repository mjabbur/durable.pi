import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Invariante de docs/DURABILITY.md §2: efeito externo não pode duplicar
// quando o processo morre entre a chamada e o commit do resultado.
//
// O filho roda um Harness real sobre SQLite em arquivo e chama um provedor sem
// idempotência (cada cobrança vira uma linha no log). O kill é SIGKILL de
// dentro do processo, no ponto exato depois da cobrança e antes do commit.

const CHILD = fileURLToPath(new URL("./fixtures/effect-child.mjs", import.meta.url));
const TIMEOUT = 30_000;

interface Run {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
}

function runChild(
	mode: "crash" | "resume",
	db: string,
	effects: string,
	env: Record<string, string> = {},
): Promise<Run> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CHILD, mode, db, effects], {
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "ignore"],
		});
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			resolve({ code, signal, stdout });
		});
	});
}

async function charges(effects: string): Promise<string[]> {
	try {
		const text = await readFile(effects, "utf8");
		return text.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

async function withDb(run: (dir: string, db: string, effects: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "durable-crash-"));
	try {
		await run(dir, join(dir, "session.sqlite"), join(dir, "effects.log"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("crash com efeito externo", () => {
	it(
		"SIGKILL depois da cobrança: resume completa sem cobrar duas vezes",
		async () => {
			await withDb(async (_dir, db, effects) => {
				const crashed = await runChild("crash", db, effects, { CRASH_AT: "after" });
				expect(crashed.signal).toBe("SIGKILL");
				expect(await charges(effects)).toEqual(["charge-1"]);

				const resumed = await runChild("resume", db, effects);
				expect(resumed.code).toBe(0);
				expect(JSON.parse(resumed.stdout) as { status: string }).toMatchObject({
					status: "terminal",
					outcome: "completed",
				});

				expect(await charges(effects)).toEqual(["charge-1"]);
			});
		},
		TIMEOUT,
	);

	it(
		"SIGKILL antes da cobrança: resume cobra exatamente uma vez",
		async () => {
			await withDb(async (_dir, db, effects) => {
				const crashed = await runChild("crash", db, effects, { CRASH_AT: "before" });
				expect(crashed.signal).toBe("SIGKILL");
				expect(await charges(effects)).toEqual([]);

				const resumed = await runChild("resume", db, effects);
				expect(resumed.code).toBe(0);
				expect(await charges(effects)).toEqual(["charge-1"]);
			});
		},
		TIMEOUT,
	);

	it(
		"resume repetido sobre tarefa terminal não cobra de novo",
		async () => {
			await withDb(async (_dir, db, effects) => {
				await runChild("crash", db, effects, { CRASH_AT: "after" });
				await runChild("resume", db, effects);
				const again = await runChild("resume", db, effects);

				expect(again.code).toBe(0);
				expect(await charges(effects)).toEqual(["charge-1"]);
			});
		},
		TIMEOUT,
	);

	it(
		"chave estável no provedor idempotente: crash não cobra duas vezes",
		async () => {
			await withDb(async (_dir, db, effects) => {
				const crashed = await runChild("crash", db, effects, {
					CRASH_AT: "after",
					TASK: "keyed",
				});
				expect(crashed.signal).toBe("SIGKILL");
				expect(await charges(effects)).toEqual(["charge-1"]);

				const resumed = await runChild("resume", db, effects, { TASK: "keyed" });
				expect(resumed.code).toBe(0);
				expect(await charges(effects)).toEqual(["charge-1"]);
			});
		},
		TIMEOUT,
	);
});
