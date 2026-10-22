import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/main.js";

let stdout: string;
let stderr: string;
let configDir: string;
let configPath: string;

/**
 * Catálogo com um único provedor faux. Só o ref devolvido resolve, então a
 * precedência fica observável no sucesso da execução: `no_model` não diz qual
 * modelo foi pedido, e era por isso que o teste antigo passava mesmo se a flag
 * fosse ignorada.
 */
function fauxCatalog(provider: string): {
	models: ReturnType<typeof createModels>;
	ref: string;
} {
	const faux = fauxProvider({ provider });
	faux.setResponses([fauxAssistantMessage("resposta")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const modelo = faux.getModel();
	return { models, ref: `${modelo.provider}/${modelo.id}` };
}

beforeEach(async () => {
	configDir = await mkdtemp(join(tmpdir(), "durable-cli-config-"));
	configPath = join(configDir, "config.json");
	process.env["DURABLE_PI_AGENT_CONFIG"] = configPath;
	// Isola a precedência do ambiente de quem roda os testes.
	delete process.env["DURABLE_PI_MODEL"];
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
	delete process.env["DURABLE_PI_MODEL"];
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
		const { models, ref } = fauxCatalog("config");
		await writeFile(configPath, JSON.stringify({ model: ref }));

		const code = await main(["-p", "x", "--no-session"], { models });

		expect(code).toBe(0);
		expect(stdout).toContain("resposta");
	});

	it("DURABLE_PI_MODEL vence o arquivo de config", async () => {
		const { models, ref } = fauxCatalog("env");
		await writeFile(configPath, JSON.stringify({ model: "config/x" }));
		process.env["DURABLE_PI_MODEL"] = ref;

		const code = await main(["-p", "x", "--no-session"], { models });

		expect(code).toBe(0);
		expect(stdout).toContain("resposta");
	});

	it("--model vence DURABLE_PI_MODEL e o config", async () => {
		const { models, ref } = fauxCatalog("flag");
		const ambiente = fauxCatalog("env").ref;
		await writeFile(configPath, JSON.stringify({ model: "config/x" }));
		process.env["DURABLE_PI_MODEL"] = ambiente;

		const code = await main(
			["-p", "x", "--model", ref, "--no-session"],
			{ models },
		);

		expect(code).toBe(0);
		expect(stdout).toContain("resposta");
	});

	it("--model inválido não cai para DURABLE_PI_MODEL nem para o config", async () => {
		const { models, ref } = fauxCatalog("env");
		await writeFile(configPath, JSON.stringify({ model: "config/x" }));
		process.env["DURABLE_PI_MODEL"] = ref;

		const code = await main(
			["-p", "x", "--model", "flag/x", "--no-session"],
			{ models },
		);

		expect(code).toBe(1);
		expect(stderr).toContain("no_model");
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
