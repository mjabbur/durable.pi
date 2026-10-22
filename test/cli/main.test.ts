import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/main.js";

let stdout: string;
let stderr: string;

beforeEach(() => {
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

afterEach(() => {
	vi.restoreAllMocks();
});

describe("main", () => {
	it("imprime a ajuda e sai com 0", async () => {
		expect(await main(["--help"])).toBe(0);
		expect(stdout).toContain("durable-pi");
	});

	it("sai com 2 e mostra o uso em erro de argumento", async () => {
		expect(await main(["-p", "x"])).toBe(2);
		expect(stderr).toContain("--model");
		expect(stderr).toContain("Uso:");
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
