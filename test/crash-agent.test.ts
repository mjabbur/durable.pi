import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Invariante de docs/DURABILITY.md §2 exercitado pelo caminho real do agente:
// `openAgent()` + `ask()`. O filho morre dentro da requisição ao modelo, depois
// de o input ser admitido. Reabrir e repetir o mesmo prompt não pode admitir um
// segundo input: o requestId commitado antes da submissão devolve a submissão
// existente.

const CHILD = fileURLToPath(new URL("./fixtures/agent-child.mjs", import.meta.url));
const TIMEOUT = 60_000;

interface Run {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

interface Resultado {
	status: string;
	answer?: string;
	userEntries: number;
}

function runChild(
	mode: "crash" | "resume",
	db: string,
	cwd: string,
	prompt: string,
): Promise<Run> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CHILD, mode, db, cwd, prompt], {
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
			resolve({ code, signal, stdout, stderr });
		});
	});
}

function parse(run: Run): Resultado {
	return JSON.parse(run.stdout) as Resultado;
}

async function withDb(run: (db: string, cwd: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "durable-agent-crash-"));
	try {
		await run(join(dir, "session.sqlite"), join(dir, "workspace"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("crash no caminho do agente", () => {
	it(
		"SIGKILL durante a geração: repetir o prompt não duplica o input",
		async () => {
			await withDb(async (db, cwd) => {
				const crashed = await runChild("crash", db, cwd, "crie um arquivo");
				expect(crashed.signal).toBe("SIGKILL");

				const resumed = await runChild("resume", db, cwd, "crie um arquivo");
				expect(resumed.code).toBe(0);

				const resultado = parse(resumed);
				expect(resultado.status).toBe("done");
				expect(resultado.answer).toBe("resposta final");
				// Uma única entrada de usuário: a submissão foi reaproveitada.
				expect(resultado.userEntries).toBe(1);
			});
		},
		TIMEOUT,
	);

	it(
		"lock órfão do processo morto não impede a retomada",
		async () => {
			await withDb(async (db, cwd) => {
				const crashed = await runChild("crash", db, cwd, "oi");
				expect(crashed.signal).toBe("SIGKILL");

				const resumed = await runChild("resume", db, cwd, "oi");
				expect(resumed.code).toBe(0);
				expect(parse(resumed).status).toBe("done");
			});
		},
		TIMEOUT,
	);
});
