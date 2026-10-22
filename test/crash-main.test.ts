import { spawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// O crash test do agente (`crash-agent.test.ts`) mata o filho dentro de
// `ask()`. Este exercita a borda que o CLI realmente executa: `main()` resolve
// a sessão, abre o banco e só depois admite o input. Sem isso, uma regressão
// em `resolveSessionId` — trocar de banco ao reabrir — deixaria o outro teste
// verde e a promessa de retomada quebrada.

const CHILD = fileURLToPath(
	new URL("./fixtures/main-child.mjs", import.meta.url),
);
const TIMEOUT = 60_000;
const PROMPT = "crie um arquivo";
const SESSION = "s1";

interface Run {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
}

function runChild(
	mode: "crash" | "crash-after-tool" | "resume" | "count",
	sessionDir: string,
	cwd: string,
): Promise<Run> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[CHILD, mode, sessionDir, SESSION, PROMPT],
			{ cwd, stdio: ["ignore", "pipe", "pipe"] },
		);
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

/** Última linha do filho: `main()` imprime a resposta antes do JSON do teste. */
function lastJson<T>(stdout: string): T {
	const lines = stdout.trimEnd().split("\n");
	const last = lines.at(-1);
	if (last === undefined) throw new Error(`stdout vazio: ${stdout}`);
	return JSON.parse(last) as T;
}

async function withSession(run: (dir: string, cwd: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "durable-main-crash-"));
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "workspace");
	await mkdir(sessionDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
	try {
		await run(sessionDir, cwd);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("crash no caminho do CLI", () => {
	it(
		"SIGKILL durante a geração: --session reabre o mesmo banco e não duplica o input",
		async () => {
			await withSession(async (sessionDir, cwd) => {
				const crashed = await runChild("crash", sessionDir, cwd);
				expect(crashed.signal).toBe("SIGKILL");

				const resumed = await runChild("resume", sessionDir, cwd);
				expect(resumed.code).toBe(0);
				expect(resumed.stdout).toContain("resposta final");
				expect(lastJson<{ code: number }>(resumed.stdout).code).toBe(0);

				// Nenhum banco novo: a retomada usou o mesmo arquivo, e não outro id.
				const bancos = (await readdir(sessionDir)).filter((name) =>
					name.endsWith(".sqlite"),
				);
				expect(bancos).toEqual([`${SESSION}.sqlite`]);

				const counted = await runChild("count", sessionDir, cwd);
				expect(
					lastJson<{
						userEntries: number;
						toolResults: number;
						toolCalls: number;
					}>(counted.stdout),
				).toEqual({ userEntries: 1, toolResults: 0, toolCalls: 0 });
			});
		},
		TIMEOUT,
	);

	it(
		"SIGKILL depois do efeito da tool: retomada não repete a chamada",
		async () => {
			await withSession(async (sessionDir, cwd) => {
				const crashed = await runChild("crash-after-tool", sessionDir, cwd);
				expect(crashed.signal).toBe("SIGKILL");
				// O `write` já rodou: o efeito está commitado antes do crash.
				expect(await readFile(join(cwd, "saida.txt"), "utf8")).toBe("uma vez\n");

				const resumed = await runChild("resume", sessionDir, cwd);
				expect(resumed.code).toBe(0);
				expect(resumed.stdout).toContain("resposta final");

				// A geração continua do checkpoint: um único par chamada/resultado e
				// o arquivo não foi escrito de novo.
				const counted = await runChild("count", sessionDir, cwd);
				expect(
					lastJson<{
						userEntries: number;
						toolResults: number;
						toolCalls: number;
					}>(counted.stdout),
				).toEqual({ userEntries: 1, toolResults: 1, toolCalls: 1 });
				expect(await readFile(join(cwd, "saida.txt"), "utf8")).toBe("uma vez\n");
			});
		},
		TIMEOUT,
	);

	it(
		"lock órfão do processo morto é recuperado na reabertura",
		async () => {
			await withSession(async (sessionDir, cwd) => {
				const crashed = await runChild("crash", sessionDir, cwd);
				expect(crashed.signal).toBe("SIGKILL");

				const resumed = await runChild("resume", sessionDir, cwd);
				expect(resumed.code).toBe(0);
				expect(resumed.stderr).toBe("");
			});
		},
		TIMEOUT,
	);
});
