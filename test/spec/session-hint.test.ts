import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";

import { closeAgent } from "../../src/agent/harness.js";
import { acquireStorageLock } from "../../src/agent/lock.js";
import { main } from "../../src/cli/main.js";
import type { TuiOptions } from "../../src/tui/app.js";

/** Catálogo faux: abre sessão real sem provedor de verdade. */
function makeModels(): Models {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "teste" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

function startCapture(): { text: () => string; restore: () => void } {
	const original = process.stderr.write.bind(process.stderr);
	let text = "";
	const replacement = (...args: unknown[]): boolean => {
		if (args.length > 0) text += String(args[0]);
		return true;
	};
	Object.defineProperty(process.stderr, "write", {
		value: replacement,
		writable: true,
		configurable: true,
	});
	return {
		text: () => text,
		restore: () => {
			Object.defineProperty(process.stderr, "write", {
				value: original,
				writable: true,
				configurable: true,
			});
		},
	};
}

function setTty(value: boolean): () => void {
	const stdinWas = process.stdin.isTTY;
	const stdoutWas = process.stdout.isTTY;
	Object.defineProperty(process.stdin, "isTTY", {
		value,
		configurable: true,
	});
	Object.defineProperty(process.stdout, "isTTY", {
		value,
		configurable: true,
	});
	return () => {
		Object.defineProperty(process.stdin, "isTTY", {
			value: stdinWas,
			configurable: true,
		});
		Object.defineProperty(process.stdout, "isTTY", {
			value: stdoutWas,
			configurable: true,
		});
	};
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "durable-pi-hint-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("dica de sessão", () => {
	it("item 1: interativo com código 1 devolve 1 e escreve a dica com o id", async () => {
		await withDir(async (dir) => {
			const id = "sessao1";
			const restoreTty = setTty(true);
			const capture = startCapture();
			try {
				const code = await main(
					["--model", "faux/teste", "--session-dir", dir, "--session", id],
					{
						models: makeModels(),
						runTui: () => Promise.resolve({ code: 1 }),
					},
				);
				expect(code).toBe(1);
				expect(capture.text()).toContain(
					`sessão: ${id} — retome com durable-pi --session ${id} ...`,
				);
			} finally {
				capture.restore();
				restoreTty();
			}
		});
	});

	it("item 2: depois de troca pela TUI a dica usa o id da nova sessão", async () => {
		await withDir(async (dir) => {
			const oldId = "antiga2";
			let created = "";
			const restoreTty = setTty(true);
			const capture = startCapture();
			try {
				const code = await main(
					["--model", "faux/teste", "--session-dir", dir, "--session", oldId],
					{
						models: makeModels(),
						runTui: (options: TuiOptions) => {
							const pending =
								options.sessions === undefined
									? Promise.resolve(undefined)
									: options.sessions.create();
							return pending.then((switched) => {
								if (switched !== undefined) created = switched.id;
								return { code: 1 };
							});
						},
					},
				);
				expect(code).toBe(1);
				expect(created).not.toBe("");
				expect(created).not.toBe(oldId);
				expect(capture.text()).toContain(`sessão: ${created}`);
				expect(capture.text()).not.toContain(`sessão: ${oldId}`);
			} finally {
				capture.restore();
				restoreTty();
			}
		});
	});

	it("item 3: código 0 não escreve dica", async () => {
		await withDir(async (dir) => {
			const restoreTty = setTty(true);
			const capture = startCapture();
			try {
				const code = await main(
					["--model", "faux/teste", "--session-dir", dir, "--session", "sessao3"],
					{
						models: makeModels(),
						runTui: () => Promise.resolve({ code: 0 }),
					},
				);
				expect(code).toBe(0);
				expect(capture.text()).not.toContain("sessão:");
			} finally {
				capture.restore();
				restoreTty();
			}
		});
	});

	it("item 4: --no-session com código 1 não escreve dica", async () => {
		await withDir(async (dir) => {
			const restoreTty = setTty(true);
			const capture = startCapture();
			try {
				const code = await main(
					["--model", "faux/teste", "--session-dir", dir, "--no-session"],
					{
						models: makeModels(),
						runTui: () => Promise.resolve({ code: 1 }),
					},
				);
				expect(code).toBe(1);
				expect(capture.text()).not.toContain("sessão:");
			} finally {
				capture.restore();
				restoreTty();
			}
		});
	});

	it("item 5: modo impresso escreve a dica uma única vez no caminho de falha", async () => {
		await withDir(async (dir) => {
			const id = "impressa5";
			const held = await acquireStorageLock(join(dir, `${id}.sqlite`));
			const capture = startCapture();
			try {
				const code = await main(
					["-p", "ola", "--model", "faux/teste", "--session-dir", dir, "--session", id],
					{ models: makeModels() },
				);
				expect(code).toBe(1);
				expect(capture.text()).toContain(`sessão: ${id}`);
				expect(capture.text().split("sessão:").length - 1).toBe(1);
			} finally {
				capture.restore();
				await held.release();
			}
		});
	});

	it("item 6: erro de uso (código 2) não escreve dica", async () => {
		await withDir(async (dir) => {
			const capture = startCapture();
			try {
				const code = await main(["--opcao-inexistente", "--session-dir", dir], {
					models: makeModels(),
				});
				expect(code).toBe(2);
				expect(capture.text()).not.toContain("sessão:");
			} finally {
				capture.restore();
			}
		});
	});

	it("item 7: falha no finally rebaixa o código para 1 e a dica usa o id corrente", async () => {
		await withDir(async (dir) => {
			const id = "sessao7";
			const restoreTty = setTty(true);
			const capture = startCapture();
			try {
				const code = await main(
					["--model", "faux/teste", "--session-dir", dir, "--session", id],
					{
						models: makeModels(),
						runTui: (options: TuiOptions) => {
							return closeAgent(options.session, BACKGROUND_CONTEXT).then(() => ({
								code: 0,
							}));
						},
					},
				);
				expect(code).toBe(1);
				expect(capture.text()).toContain(`sessão: ${id}`);
			} finally {
				capture.restore();
				restoreTty();
			}
		});
	});
});
