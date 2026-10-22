import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Invariante de docs/DURABILITY.md §2 sobre o código real de `chargeOnce`: o
// processo morre entre a cobrança e o commit do resultado. O resume tem que
// reaproveitar a chave gravada na intenção, não gerar outra.
//
// O filho roda SQLite em arquivo e um provedor idempotente por chave; o log de
// efeitos conta cobranças efetivas, então "cobrou duas vezes" é uma linha a mais.

const CHILD = fileURLToPath(new URL("./fixtures/charge-child.mjs", import.meta.url));
const TIMEOUT = 30_000;

interface Run {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
}

interface ChargeOutput {
	result: { status: string; key: string; amountCents: number };
	stored: { status: string; key: string; amountCents: number } | null;
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
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code !== 0 && signal === null) {
				reject(new Error(`filho saiu com ${String(code)}: ${stderr}`));
				return;
			}
			resolve({ code, signal, stdout });
		});
	});
}

async function effects(path: string): Promise<string[]> {
	try {
		const text = await readFile(path, "utf8");
		return text.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

function parse(run: Run): ChargeOutput {
	return JSON.parse(run.stdout) as ChargeOutput;
}

async function withDb(run: (db: string, effects: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "durable-charge-crash-"));
	try {
		await run(join(dir, "session.sqlite"), join(dir, "effects.log"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("crash em chargeOnce", () => {
	it(
		"SIGKILL depois da cobrança: resume não cobra de novo e devolve o resultado",
		async () => {
			await withDb(async (db, log) => {
				const crashed = await runChild("crash", db, log, { CRASH_AT: "after" });
				expect(crashed.signal).toBe("SIGKILL");
				expect(await effects(log)).toHaveLength(1);

				const resumed = await runChild("resume", db, log);
				expect(resumed.code).toBe(0);
				expect(parse(resumed).result.status).toBe("charged");
				expect(await effects(log)).toHaveLength(1);
			});
		},
		TIMEOUT,
	);

	it(
		"SIGKILL antes da cobrança: resume cobra uma vez com a chave da intenção",
		async () => {
			await withDb(async (db, log) => {
				const crashed = await runChild("crash", db, log, { CRASH_AT: "before" });
				expect(crashed.signal).toBe("SIGKILL");
				expect(await effects(log)).toEqual([]);

				const resumed = await runChild("resume", db, log);
				expect(resumed.code).toBe(0);

				const charged = await effects(log);
				expect(charged).toHaveLength(1);
				// A cobrança usou a chave que estava na intenção durável.
				expect(parse(resumed).stored?.key).toBe(charged[0]);
			});
		},
		TIMEOUT,
	);

	it(
		"resume repetido sobre resultado gravado não chama o provedor",
		async () => {
			await withDb(async (db, log) => {
				await runChild("crash", db, log, { CRASH_AT: "after" });
				const first = await runChild("resume", db, log);
				const again = await runChild("resume", db, log);

				expect(again.code).toBe(0);
				expect(parse(again).result).toEqual(parse(first).result);
				expect(await effects(log)).toHaveLength(1);
			});
		},
		TIMEOUT,
	);
});
