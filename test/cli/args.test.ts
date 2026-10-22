import { describe, expect, it } from "vitest";

import { parseArgs, UsageError } from "../../src/cli/args.js";

const env = { DURABLE_PI_SESSION_DIR: "/tmp/sessions" };

describe("parseArgs", () => {
	it("lê prompt por -p e modelo por --model", () => {
		const options = parseArgs(
			["-p", "crie x", "--model", "opencode-go/modelo", "--session-dir", "/d"],
			env,
		);
		expect(options).toEqual({
			mode: "print",
			prompt: "crie x",
			model: "opencode-go/modelo",
			sessionDir: "/d",
			resume: false,
			noSession: false,
		});
	});

	it("aceita o prompt posicional e o modelo do ambiente", () => {
		const options = parseArgs(["explique", "o", "repo"], {
			...env,
			DURABLE_PI_MODEL: "p/m",
		});
		expect(options).toMatchObject({ prompt: "explique o repo", model: "p/m" });
	});

	it("carrega --session, --continue e --no-session", () => {
		expect(
			parseArgs(["-p", "x", "--model", "p/m", "--session", "abc"], env),
		).toMatchObject({ sessionId: "abc" });
		expect(parseArgs(["-p", "x", "--model", "p/m", "-c"], env)).toMatchObject({
			resume: true,
		});
		expect(
			parseArgs(["-p", "x", "--model", "p/m", "--no-session"], env),
		).toMatchObject({ noSession: true });
	});

	it("recusa prompt vazio, opção desconhecida e modelo ausente", () => {
		expect(() => parseArgs(["--model", "p/m"], env)).toThrow(UsageError);
		expect(() => parseArgs(["-p", "x", "--nope"], env)).toThrow(UsageError);
		expect(() => parseArgs(["-p", "x"], env)).toThrow(UsageError);
	});

	it("recusa combinações incoerentes", () => {
		expect(() =>
			parseArgs(["-p", "x", "--model", "p/m", "-c", "--no-session"], env),
		).toThrow(UsageError);
		expect(() =>
			parseArgs(["-p", "x", "--model", "p/m", "--session", "../fora"], env),
		).toThrow(/inválido/);
	});

	it("devolve ajuda sem exigir prompt", () => {
		expect(parseArgs(["--help"], env)).toEqual({ mode: "help" });
	});
});
