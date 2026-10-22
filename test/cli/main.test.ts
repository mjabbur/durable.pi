import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/main.js";

let stdout: string;
let stderr: string;
let configDir: string;
let configPath: string;

beforeEach(async () => {
	configDir = await mkdtemp(join(tmpdir(), "durable-cli-config-"));
	configPath = join(configDir, "config.json");
	process.env["DURABLE_PI_AGENT_CONFIG"] = configPath;
	stdout = "";
	stderr = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdout += String(chunk);
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		stderr += String(chunk);
		return true;
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	delete process.env["DURABLE_PI_AGENT_CONFIG"];
	await rm(configDir, { recursive: true, force: true });
});

describe("main", () => {
	it("imprime a ajuda e sai com 0", async () => {
		expect(await main(["--help"])).toBe(0);
		expect(stdout).toContain("durable-pi");
	});

	it("explica onde definir o modelo quando não há flag, ambiente nem config", async () => {
		expect(await main(["-p", "x"])).toBe(2);
		expect(stderr).toContain(configPath);
		expect(stderr).toContain("Uso:");
	});

	it("sai com 2 em modelo fora do formato provider/modelo", async () => {
		expect(await main(["-p", "x", "--model", "sem-barra"])).toBe(2);
		expect(stderr).toContain("modelo inválido");
	});

	it("sai com 1 em config malformada, apontando o arquivo", async () => {
		await writeFile(configPath, "{ nao json");
		const code = await main(["-p", "x"]);
		expect(code).toBe(1);
		expect(stderr).toContain(configPath);
	});

	it("usa o modelo do arquivo de config", async () => {
		await writeFile(configPath, JSON.stringify({ model: "nao/existe" }));
		const dir = await mkdtemp(join(tmpdir(), "durable-cli-sessao-"));
		try {
			const code = await main([
				"-p",
				"x",
				"--no-session",
				"--session-dir",
				dir,
			]);
			// Passou da resolução do modelo: o erro agora é do provedor.
			expect(code).toBe(1);
			expect(stderr).toContain("no_model");
			expect(stderr).not.toContain("defina o modelo");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("--model vence o arquivo de config", async () => {
		await writeFile(configPath, JSON.stringify({ model: "config/x" }));
		const dir = await mkdtemp(join(tmpdir(), "durable-cli-sessao-"));
		try {
			const code = await main([
				"-p",
				"x",
				"--model",
				"flag/y",
				"--no-session",
				"--session-dir",
				dir,
			]);
			expect(code).toBe(1);
			expect(stderr).toContain("no_model");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("sai com 2, sem stack trace, em id de sessão inválido", async () => {
		const code = await main([
			"-p",
			"x",
			"--model",
			"p/m",
			"--session",
			"../fora",
		]);

		expect(code).toBe(2);
		expect(stderr).toContain("id de sessão inválido");
		expect(stderr).not.toContain("    at ");
	});

	it("sai com 1 quando não há sessão para continuar", async () => {
		const dir = `/tmp/durable-vazio-${Date.now()}`;
		const code = await main([
			"-p",
			"x",
			"--model",
			"p/m",
			"--session-dir",
			dir,
			"--continue",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("nenhuma sessão");
	});
});
