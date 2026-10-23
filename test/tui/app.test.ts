import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import {
	TuiMainScreen,
	type ProgramStatus,
	type Terminal,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { closeAgent, openAgent } from "../../src/agent/harness.js";
import { listSessions, newSessionId } from "../../src/agent/sessions.js";
import { runTui } from "../../src/tui/app.js";

const context = BACKGROUND_CONTEXT;

/**
 * Terminal de mentira: o `runTui` só usa a interface `Terminal`, então dá para
 * dirigir a TUI inteira sem TTY. `send()` entrega bytes como o `process.stdin`
 * em modo raw entregaria.
 */
class FakeTerminal implements Terminal {
	readonly columns = 80;
	readonly rows = 24;
	readonly writes: string[] = [];
	#input: ((data: string) => void) | undefined;

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.#input = onInput;
	}

	stop(): void {
		this.#input = undefined;
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	get kittyProtocolActive(): boolean {
		return false;
	}

	write(data: string): void {
		this.writes.push(data);
	}

	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(_status: ProgramStatus): void {}

	send(data: string): void {
		const input = this.#input;
		if (input === undefined) throw new Error("terminal não iniciado");
		input(data);
	}

	get text(): string {
		return this.writes.join("");
	}

	/** Só o que foi escrito depois do marco: a TUI acumula frames, e "ocioso" do primeiro frame não prova nada. */
	since(mark: number): string {
		return this.writes.slice(mark).join("");
	}
}

async function waitFor(
	condition: () => boolean,
	label: string,
	timeoutMs = 5_000,
): Promise<void> {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error(`tempo esgotado esperando ${label}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const CHILD = fileURLToPath(
	new URL("../fixtures/main-child.mjs", import.meta.url),
);

/**
 * Monta a sessão morta de SIGKILL na requisição ao modelo. `crash-admitted`
 * limpa a intenção antes de morrer: restam submissão e task, sem fila a
 * reconciliar, então só `harness.resume()` pode religar o scheduler.
 */
function crashChild(
	sessionDir: string,
	mode: "crash" | "crash-admitted" = "crash",
): Promise<NodeJS.Signals | null> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[CHILD, mode, sessionDir, "s1", "pedido antigo"],
			{ cwd: process.cwd(), stdio: "ignore" },
		);
		child.on("error", reject);
		child.on("close", (_code, signal) => resolve(signal));
	});
}

async function withFake(
	run: (deps: {
		terminal: FakeTerminal;
		handle: Awaited<ReturnType<typeof openAgent>>;
		dir: string;
		dbPath: string;
	}) => Promise<void>,
) {
	const dir = await mkdtemp(join(tmpdir(), "durable-tui-app-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const dbPath = join(dir, "session.sqlite");
	const handle = await openAgent(
		{
			dbPath,
			cwd: dir,
			model: { provider: model.provider, modelId: model.id },
			models,
		},
		context,
	);
	faux.setResponses([fauxAssistantMessage("resposta final")]);
	try {
		await run({ terminal: new FakeTerminal(), handle, dir, dbPath });
	} finally {
		await closeAgent(handle, context);
		await rm(dir, { recursive: true, force: true });
	}
}

describe("TUI", () => {
	it("mostra o prompt, a resposta e sai no Ctrl+C ocioso", async () => {
		await withFake(async ({ terminal, handle }) => {
			const running = runTui({ session: handle, context, terminal });

			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");
			terminal.send("olá");
			terminal.send("\r");

			await waitFor(
				() => terminal.text.includes("resposta final"),
				"resposta no transcript",
			);
			expect(terminal.text).toContain("olá");
			await waitFor(() => terminal.text.includes("ocioso"), "turno encerrado");

			terminal.send("\u0003");
			await expect(running).resolves.toEqual({ code: 0 });
		});
	});

	it("!comando mostra a saída e sobrevive ao resume", async () => {
		const dir = await mkdtemp(join(tmpdir(), "durable-tui-shell-"));
		const dbPath = join(dir, "session.sqlite");
		const openFake = async () => {
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			const model = faux.getModel();
			const handle = await openAgent(
				{
					dbPath,
					cwd: dir,
					model: { provider: model.provider, modelId: model.id },
					models,
				},
				context,
			);
			faux.setResponses([fauxAssistantMessage("resposta final")]);
			return handle;
		};

		try {
			const handle = await openFake();
			const terminal = new FakeTerminal();
			const running = runTui({ session: handle, context, terminal });
			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");

			terminal.send("!echo persistido");
			terminal.send("\r");
			await waitFor(
				() => terminal.text.includes("persistido"),
				"saída do comando",
			);
			await waitFor(() => terminal.text.includes("ocioso"), "comando encerrado");

			terminal.send("/quit");
			terminal.send("\r");
			await expect(running).resolves.toEqual({ code: 0 });
			await closeAgent(handle, context);

			// Reabre o mesmo banco: o bloco de shell é entrada durável.
			const reopened = await openFake();
			try {
				const view = await reopened.conversation.context(context);
				expect(
					view.entries.some((entry) => entry.kind === "durable.shell"),
				).toBe(true);
			} finally {
				await closeAgent(reopened, context);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("saída de shell com ANSI/OSC chega ao terminal como texto", async () => {
		const dir = await mkdtemp(join(tmpdir(), "durable-tui-"));
		const dbPath = join(dir, "session.sqlite");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const openFake = async (): Promise<Awaited<ReturnType<typeof openAgent>>> =>
			openAgent(
				{
					dbPath,
					cwd: dir,
					model: { provider: model.provider, modelId: model.id },
					models,
				},
				context,
			);

		try {
			const handle = await openFake();
			const terminal = new FakeTerminal();
			const running = runTui({ session: handle, context, terminal });
			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");

			// ESC[2J limparia a tela; ESC]0;t trocaria o título.
			terminal.send("!printf 'a\\033[2Jb\\033]0;t\\007c'");
			terminal.send("\r");
			await waitFor(() => terminal.text.includes("abc"), "saída filtrada");
			expect(terminal.text).not.toContain("a\u001b[2Jb");
			expect(terminal.text).not.toContain("\u001b]0;t");

			terminal.send("/quit");
			terminal.send("\r");
			await expect(running).resolves.toEqual({ code: 0 });
			await closeAgent(handle, context);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("/model e /thinking passam pelo configure() do agente", async () => {
		await withFake(async ({ terminal, handle }) => {
			const running = runTui({ session: handle, context, terminal });
			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");

			terminal.send("/model outro/modelo");
			terminal.send("\r");
			await waitFor(
				() => terminal.text.includes("outro/modelo"),
				"modelo no status",
			);
			expect(
				(await handle.conversation.agent(context)).model,
			).toMatchObject({ provider: "outro", modelId: "modelo" });

			terminal.send("/thinking alto");
			terminal.send("\r");
			await waitFor(
				() => terminal.text.includes("nível inválido"),
				"nível recusado",
			);
			expect(
				(await handle.conversation.agent(context)).thinkingLevel,
			).not.toBe("alto");

			terminal.send("/thinking high");
			terminal.send("\r");
			await waitFor(() => terminal.text.includes("raciocínio"), "nível aceito");
			expect((await handle.conversation.agent(context)).thinkingLevel).toBe(
				"high",
			);

			terminal.send("/quit");
			terminal.send("\r");
			await expect(running).resolves.toEqual({ code: 0 });
		});
	});

	it("/new cria outra sessão e /resume volta para a primeira", async () => {
		const dir = await mkdtemp(join(tmpdir(), "durable-tui-switch-"));
		const open = async (id: string) => {
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			const model = faux.getModel();
			const handle = await openAgent(
				{
					dbPath: join(dir, `${id}.sqlite`),
					cwd: dir,
					model: { provider: model.provider, modelId: model.id },
					models,
				},
				context,
			);
			faux.setResponses([fauxAssistantMessage(`resposta de ${id}`)]);
			return handle;
		};

		let current = await open("s1");
		let created: string | undefined;
		const swap = async (id: string) => {
			const opened = await open(id);
			const previous = current;
			current = opened;
			await closeAgent(previous, context);
			return { session: opened, id };
		};
		const switcher = {
			list: () => listSessions(dir),
			open: swap,
			create: async () => {
				created = newSessionId();
				return swap(created);
			},
		};

		try {
			const terminal = new FakeTerminal();
			const running = runTui({
				session: current,
				context,
				terminal,
				sessions: switcher,
			});
			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");

			terminal.send("/new");
			terminal.send("\r");
			await waitFor(() => created !== undefined, "sessão criada");
			await waitFor(
				() => terminal.text.includes(`sessão ${created ?? ""}`),
				"aviso da nova sessão",
			);
			expect((await readdir(dir)).filter((n) => n.endsWith(".sqlite"))).toHaveLength(2);

			terminal.send("/resume s1");
			terminal.send("\r");
			await waitFor(() => terminal.text.includes("sessão s1"), "aviso do resume");

			// O prompt vai para a sessão retomada, não para a recém-criada.
			terminal.send("olá");
			terminal.send("\r");
			await waitFor(
				() => terminal.text.includes("resposta de s1"),
				"resposta da sessão s1",
			);

			terminal.send("/quit");
			terminal.send("\r");
			await expect(running).resolves.toEqual({ code: 0 });
			await closeAgent(current, context);
			current = await open(created ?? "");
			const criada = await current.conversation.context(context);
			expect(criada.entries).toEqual([]);
			await closeAgent(current, context);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("falha ao abrir a nova sessão reata a anterior e mantém o aviso", async () => {
		const dir = await mkdtemp(join(tmpdir(), "durable-tui-open-fail-"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const open = (id: string) =>
			openAgent(
				{
					dbPath: join(dir, `${id}.sqlite`),
					cwd: dir,
					model: { provider: model.provider, modelId: model.id },
					models,
				},
				context,
			);
		const current = await open("s1");
		const switcher = {
			list: () => listSessions(dir),
			open: (): Promise<never> => Promise.reject(new Error("disco cheio")),
			create: (): Promise<never> => Promise.reject(new Error("disco cheio")),
		};

		try {
			const terminal = new FakeTerminal();
			const running = runTui({
				session: current,
				context,
				terminal,
				sessions: switcher,
			});
			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");

			const mark = terminal.writes.length;
			terminal.send("/new");
			terminal.send("\r");
			await waitFor(
				() => terminal.since(mark).includes("disco cheio"),
				"aviso da falha",
			);

			// A anterior continua viva e aceita o próximo turno.
			faux.setResponses([fauxAssistantMessage("ainda aqui")]);
			terminal.send("pergunta");
			terminal.send("\r");
			await waitFor(
				() => terminal.text.includes("ainda aqui"),
				"resposta na sessão anterior",
			);
			terminal.send("/quit");
			terminal.send("\r");
			await expect(running).resolves.toEqual({ code: 0 });
			await closeAgent(current, context);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("falha ao anexar depois da abertura encerra com 1 sem reatar a anterior", async () => {
		const dir = await mkdtemp(join(tmpdir(), "durable-tui-attach-fail-"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const open = (id: string) =>
			openAgent(
				{
					dbPath: join(dir, `${id}.sqlite`),
					cwd: dir,
					model: { provider: model.provider, modelId: model.id },
					models,
				},
				context,
			);
		const current = await open("s1");
		// O dono do storage já teria fechado a anterior; a nova aberta morre
		// antes do attachment — o watchEvents/agent falha.
		const doomed = await open("s2");
		await closeAgent(doomed, context);
		const switcher = {
			list: () => listSessions(dir),
			open: () => Promise.resolve({ session: doomed, id: "s2" }),
			create: () => Promise.resolve({ session: doomed, id: "s2" }),
		};
		const chunks: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		const capture = (chunk: unknown): boolean => {
			chunks.push(String(chunk));
			return true;
		};
		process.stderr.write = capture;

		try {
			const terminal = new FakeTerminal();
			const running = runTui({
				session: current,
				context,
				terminal,
				sessions: switcher,
			});
			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");

			terminal.send("/new");
			terminal.send("\r");
			await expect(running).resolves.toEqual({ code: 1 });
			expect(chunks.join("")).toContain("falha ao anexar a sessão s2");
		} finally {
			process.stderr.write = original;
			await closeAgent(current, context);
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("troca em andamento recusa outra troca e entrada", async () => {
		const dir = await mkdtemp(join(tmpdir(), "durable-tui-serial-"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const open = (id: string) =>
			openAgent(
				{
					dbPath: join(dir, `${id}.sqlite`),
					cwd: dir,
					model: { provider: model.provider, modelId: model.id },
					models,
				},
				context,
			);
		let current = await open("s1");
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let opened = 0;
		const switcher = {
			list: () => listSessions(dir),
			open: async (id: string) => {
				opened += 1;
				await gate;
				const session = await open(id);
				const previous = current;
				current = session;
				await closeAgent(previous, context);
				return { session, id };
			},
			create: async () => {
				opened += 1;
				await gate;
				const id = newSessionId();
				const session = await open(id);
				const previous = current;
				current = session;
				await closeAgent(previous, context);
				return { session, id };
			},
		};

		try {
			const terminal = new FakeTerminal();
			const running = runTui({
				session: current,
				context,
				terminal,
				sessions: switcher,
			});
			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");

			terminal.send("/new");
			terminal.send("\r");
			// Um frame entre as entradas: como digitar, não um paste de dois comandos.
			await new Promise((resolve) => setTimeout(resolve, 50));
			terminal.send("/new");
			terminal.send("\r");
			await waitFor(
				() => terminal.text.includes("troca de sessão em andamento"),
				"segunda troca recusada",
			);
			const refused = (): number =>
				terminal.text.split("troca de sessão em andamento").length - 1;
			let expected = refused();
			for (const entry of [
				"prompt durante a troca",
				"!echo durante a troca",
				"/model outro/modelo",
			]) {
				terminal.send(entry);
				terminal.send("\r");
				expected += 1;
				await waitFor(
					() => refused() === expected,
					`entrada recusada: ${entry}`,
				);
			}
			expect(opened).toBe(1);

			release?.();
			await waitFor(
				() => terminal.text.includes("sessão "),
				"troca concluída",
			);
			terminal.send("/quit");
			terminal.send("\r");
			await expect(running).resolves.toEqual({ code: 0 });
			await closeAgent(current, context);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("troca com !comando em voo reserva antes de esperar e não abre duas", async () => {
		const hasSetsid = await new Promise<boolean>((resolveCheck) => {
			spawn("sh", ["-c", "command -v setsid"], { stdio: "ignore" })
				.on("error", () => resolveCheck(false))
				.on("close", (code) => resolveCheck(code === 0));
		});
		if (!hasSetsid) return;

		const dir = await mkdtemp(join(tmpdir(), "durable-tui-shell-race-"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const open = (id: string) =>
			openAgent(
				{
					dbPath: join(dir, `${id}.sqlite`),
					cwd: dir,
					model: { provider: model.provider, modelId: model.id },
					models,
				},
				context,
			);
		let current = await open("s1");
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let opened = 0;
		const switcher = {
			list: () => listSessions(dir),
			open: async (id: string) => {
				opened += 1;
				await gate;
				const session = await open(id);
				const previous = current;
				current = session;
				await closeAgent(previous, context);
				return { session, id };
			},
			create: async () => {
				opened += 1;
				await gate;
				const id = newSessionId();
				const session = await open(id);
				const previous = current;
				current = session;
				await closeAgent(previous, context);
				return { session, id };
			},
		};

		try {
			const terminal = new FakeTerminal();
			const running = runTui({
				session: current,
				context,
				terminal,
				sessions: switcher,
			});
			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");

			// Descendente com o pipe aberto: o processo não termina, e o fechamento
			// espera o prazo de 3 s. A janela da guarda fica observável.
			const command = `!setsid bash -c 'while :; do echo vivo; sleep 0.05; done' &`;
			for (const char of command) terminal.send(char);
			terminal.send("\r");
			await waitFor(() => terminal.text.includes("shell"), "shell em voo");
			await new Promise((resolve) => setTimeout(resolve, 300));

			// O shell ainda está no prazo de término: a primeira troca espera ali.
			terminal.send("/new");
			terminal.send("\r");
			await new Promise((resolve) => setTimeout(resolve, 50));
			terminal.send("/new");
			terminal.send("\r");
			await waitFor(
				() => terminal.text.includes("troca de sessão em andamento"),
				"segunda troca recusada",
			);

			// Uma única abertura, e só depois que o shell terminou.
			expect(opened).toBe(0);
			await waitFor(() => opened === 1, "abertura única", 10_000);
			expect(opened).toBe(1);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(opened).toBe(1);

			release?.();
			await waitFor(() => terminal.text.includes("sessão "), "troca publicada");
			// O shell abandonado não pode continuar ocupando o slot da TUI.
			await new Promise((resolve) => setTimeout(resolve, 100));
			terminal.send("!echo depois-da-troca");
			terminal.send("\r");
			await waitFor(
				() => terminal.text.includes("depois-da-troca"),
				"novo shell aceito",
			);
			terminal.send("/quit");
			terminal.send("\r");
			await expect(running).resolves.toEqual({ code: 0 });
			await closeAgent(current, context);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("rejeição de comando vira aviso, sem unhandledRejection, e a TUI segue", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			await withFake(async ({ terminal, handle }) => {
				const switcher = {
					list: (): Promise<never> => Promise.reject(new Error("list-falhou")),
					open: (): Promise<never> => Promise.reject(new Error("open-falhou")),
					create: (): Promise<never> => Promise.reject(new Error("open-falhou")),
				};
				const running = runTui({
					session: handle,
					context,
					terminal,
					sessions: switcher,
				});
				await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");

				terminal.send("/resume");
				terminal.send("\r");
				await waitFor(
					() => terminal.text.includes("list-falhou"),
					"aviso da listagem",
				);

				// A TUI continua utilizável: o turno seguinte é admitido de verdade.
				terminal.send("pergunta depois da falha");
				terminal.send("\r");
				await waitFor(
					() => terminal.text.includes("resposta final"),
					"prompt aceito",
				);

				terminal.send("/quit");
				terminal.send("\r");
				await expect(running).resolves.toEqual({ code: 0 });
			});
			// Dá tempo de uma rejeição solta chegar ao processo.
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("troca é recusada enquanto uma geração retomada trabalha", async () => {
		const dir = await mkdtemp(join(tmpdir(), "durable-tui-resumed-"));
		await mkdir(dir, { recursive: true });
		expect(await crashChild(dir, "crash-admitted")).toBe("SIGKILL");

		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = false;
		faux.setResponses([
			async () => {
				started = true;
				await gate;
				return fauxAssistantMessage("resposta retomada");
			},
		]);
		const handle = await openAgent(
			{
				dbPath: join(dir, "s1.sqlite"),
				cwd: process.cwd(),
				model: { provider: model.provider, modelId: model.id },
				models,
			},
			context,
		);
		let opened = 0;
		const switcher = {
			list: () => listSessions(dir),
			open: () => {
				opened += 1;
				return Promise.reject(new Error("não deveria abrir"));
			},
			create: () => {
				opened += 1;
				return Promise.reject(new Error("não deveria abrir"));
			},
		};

		try {
			const terminal = new FakeTerminal();
			const running = runTui({
				session: handle,
				context,
				terminal,
				sessions: switcher,
			});
			await waitFor(() => started, "geração retomada iniciou");
			await waitFor(
				() => terminal.text.includes("gerando"),
				"status de geração",
			);

			terminal.send("/new");
			terminal.send("\r");
			await waitFor(
				() => terminal.text.includes("aguarde a geração"),
				"troca recusada",
			);
			expect(opened).toBe(0);

			release();
			await waitFor(() => terminal.text.includes("ocioso"), "turno terminou");
			terminal.send("/quit");
			terminal.send("\r");
			await expect(running).resolves.toEqual({ code: 0 });
		} finally {
			await closeAgent(handle, context);
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("OSC/CSI na resposta do modelo chega ao terminal como texto", async () => {
		const dir = await mkdtemp(join(tmpdir(), "durable-tui-escape-"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		faux.setResponses([
			fauxAssistantMessage("perigo\u001b]0;t\u0007\u001b[2Jfim"),
		]);
		const handle = await openAgent(
			{
				dbPath: join(dir, "session.sqlite"),
				cwd: dir,
				model: { provider: model.provider, modelId: model.id },
				models,
			},
			context,
		);
		try {
			const terminal = new FakeTerminal();
			const running = runTui({ session: handle, context, terminal });
			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");
			terminal.send("oi");
			terminal.send("\r");
			await waitFor(() => terminal.text.includes("perigo"), "resposta");
			expect(terminal.text).not.toContain("\u001b]0;t");
			expect(terminal.text).not.toContain("\u001b[2Jfim");
			terminal.send("/quit");
			terminal.send("\r");
			await expect(running).resolves.toEqual({ code: 0 });
		} finally {
			await closeAgent(handle, context);
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("Ctrl+C ocioso com terminal quebrado resolve a saída, sem rejeição solta", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			await withFake(async ({ terminal, handle }) => {
				const tui = new TuiMainScreen(terminal);
				tui.stop = () => {
					throw new Error("terminal quebrado");
				};
				const running = runTui({ session: handle, context, terminal, tui });
				await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");
				terminal.send("\u0003");
				await expect(running).resolves.toEqual({ code: 1 });
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("/resume sem argumento abre o seletor e troca no Enter", async () => {
		const dir = await mkdtemp(join(tmpdir(), "durable-tui-picker-"));
		const open = async (id: string) => {
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			const model = faux.getModel();
			return openAgent(
				{
					dbPath: join(dir, `${id}.sqlite`),
					cwd: dir,
					model: { provider: model.provider, modelId: model.id },
					models,
				},
				context,
			);
		};

		const current = await open("antiga");
		const ranged = await open("nova");
		await closeAgent(ranged, context);
		let picked: string | undefined;
		const switcher = {
			list: () => listSessions(dir),
			open: (id: string) => {
				picked = id;
				return Promise.resolve({ session: current, id });
			},
			create: () => Promise.resolve({ session: current, id: "nova" }),
		};

		try {
			const terminal = new FakeTerminal();
			const running = runTui({
				session: current,
				context,
				terminal,
				sessions: switcher,
			});
			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");

			terminal.send("/resume");
			terminal.send("\r");
			await waitFor(() => terminal.text.includes("nova"), "seletor aberto");
			terminal.send("\r");
			await waitFor(() => picked !== undefined, "sessão escolhida");
			expect(picked).toBe("nova");

			terminal.send("/quit");
			terminal.send("\r");
			await expect(running).resolves.toEqual({ code: 0 });
			await closeAgent(current, context);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("/quit encerra o loop sem chamar o modelo", async () => {
		await withFake(async ({ terminal, handle }) => {
			const running = runTui({ session: handle, context, terminal });

			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");
			terminal.send("/quit");
			terminal.send("\r");

			await expect(running).resolves.toEqual({ code: 0 });
			expect(terminal.text).not.toContain("resposta final");
		});
	});
	it("retoma sem novo prompt a sessão que morreu com pedido pendente", async () => {
		const dir = await mkdtemp(join(tmpdir(), "durable-tui-resume-"));
		const cwd = process.cwd();
		try {
			expect(await crashChild(dir, "crash-admitted")).toBe("SIGKILL");

			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			const model = faux.getModel();
			faux.setResponses([fauxAssistantMessage("retomada automática")]);
			const handle = await openAgent(
				{
					dbPath: join(dir, "s1.sqlite"),
					cwd,
					model: { provider: model.provider, modelId: model.id },
					models,
				},
				context,
			);
			try {
				const terminal = new FakeTerminal();
				const running = runTui({ session: handle, context, terminal });
				// Nenhum prompt é reenviado: quem liga o scheduler é o `attach()`.
				await waitFor(
					() => terminal.text.includes("retomada automática"),
					"resposta retomada",
					15_000,
				);

				const view = await handle.conversation.context(context);
				expect(
					view.entries.filter((entry) => entry.kind === "pi.user"),
				).toHaveLength(1);
				expect(
					view.entries.filter((entry) => entry.kind === "pi.assistant"),
				).toHaveLength(1);
				const inspection = await handle.harness.inspect(context);
				expect(inspection.submissions).toHaveLength(0);

				terminal.send("\u0003");
				await expect(running).resolves.toEqual({ code: 0 });
			} finally {
				await closeAgent(handle, context);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("Ctrl+C cancela a geração e só sai quando o turno termina", async () => {
		const dir = await mkdtemp(join(tmpdir(), "durable-tui-abort-"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage("não deveria aparecer");
			},
			fauxAssistantMessage("depois do cancelamento"),
		]);
		const handle = await openAgent(
			{
				dbPath: join(dir, "session.sqlite"),
				cwd: dir,
				model: { provider: model.provider, modelId: model.id },
				models,
			},
			context,
		);
		try {
			const terminal = new FakeTerminal();
			const running = runTui({ session: handle, context, terminal });
			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");

			terminal.send("primeira");
			terminal.send("\r");
			await waitFor(() => terminal.text.includes("gerando"), "geração iniciada");

			const mark = terminal.writes.length;
			terminal.send("\u0003");
			await waitFor(
				() => terminal.since(mark).includes("cancelando"),
				"cancelamento em curso",
			);
			// Segundo Ctrl+C no meio do aborto não pode encerrar a TUI.
			terminal.send("\u0003");
			await waitFor(
				() => terminal.since(mark).includes("aguarde"),
				"segundo Ctrl+C recusado",
			);
			// O aborto marca a task e espera a invocação em curso: com o provedor
			// travado, "cancelando" só termina quando ele responde. A resposta
			// atrasada não pode virar entrada.
			const fimDoAborto = terminal.writes.length;
			release();
			await waitFor(
				() => terminal.since(fimDoAborto).includes("ocioso"),
				"turno encerrado",
				15_000,
			);

			const view = await handle.conversation.context(context);
			expect(
				view.entries.filter((entry) => entry.kind === "pi.user"),
			).toHaveLength(1);
			expect(
				view.entries.filter((entry) => entry.kind === "pi.assistant"),
			).toHaveLength(0);
			expect((await handle.harness.inspect(context)).submissions).toHaveLength(0);

			// O loop continua utilizável depois do cancelamento.
			const segundo = terminal.writes.length;
			terminal.send("segunda");
			terminal.send("\r");
			await waitFor(
				() => terminal.since(segundo).includes("depois do cancelamento"),
				"segundo turno",
			);
			await waitFor(
				() => terminal.since(segundo).includes("ocioso"),
				"segundo turno encerrado",
			);

			terminal.send("\u0003");
			await expect(running).resolves.toEqual({ code: 0 });
		} finally {
			release();
			await closeAgent(handle, context);
			await rm(dir, { recursive: true, force: true });
		}
	}, 20_000);

	it("/quit espera o desfecho do !comando e ignora entrada no meio", async () => {
		const dir = await mkdtemp(join(tmpdir(), "durable-tui-shutdown-"));
		const dbPath = join(dir, "session.sqlite");
		const open = async () => {
			const provider = fauxProvider();
			const catalog = createModels();
			catalog.setProvider(provider.provider);
			const ref = provider.getModel();
			provider.setResponses([fauxAssistantMessage("não usado")]);
			return openAgent(
				{
					dbPath,
					cwd: dir,
					model: { provider: ref.provider, modelId: ref.id },
					models: catalog,
				},
				context,
			);
		};
		const handle = await open();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		let configures = 0;
		const configure = handle.conversation.configure.bind(
			handle.conversation,
		);
		handle.conversation.configure = (async (
			change: Parameters<typeof configure>[0],
			ctx: Parameters<typeof configure>[1],
		) => {
			configures += 1;
			return configure(change, ctx);
		});
		const original = handle.conversation.submit.bind(handle.conversation);
		let writes = 0;
		handle.conversation.submit = (async (
			draft: Parameters<typeof original>[0],
			ctx: Parameters<typeof original>[1],
		) => {
			if (draft.type === "write") {
				writes += 1;
				await gate;
			}
			return original(draft, ctx);
		});
		try {
			const terminal = new FakeTerminal();
			const running = runTui({ session: handle, context, terminal });
			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");

			const modeloAntes = (await handle.conversation.agent(context)).model;
			terminal.send("!echo pronto");
			terminal.send("\r");
			await waitFor(() => writes === 1, "desfecho do shell pendente");

			terminal.send("/quit");
			terminal.send("\r");
			// Item 9: com o fechamento pedido, nada novo pode começar.
			terminal.send("!echo depois");
			terminal.send("\r");
			terminal.send("prompt tardio");
			terminal.send("\r");
			terminal.send("/model outro/modelo");
			terminal.send("\r");

			let resolved = false;
			void running.then(() => {
				resolved = true;
			});
			await new Promise((resolveWait) => setTimeout(resolveWait, 300));
			// Item 2: a saída não resolve antes de o desfecho ser gravado.
			expect(resolved).toBe(false);
			expect(configures).toBe(0);

			release();
			await expect(running).resolves.toEqual({ code: 0 });
			// Item 2: a saída só resolveu depois do commit; confira na sessão
			// ainda aberta, sem a drenagem do close esconder uma resolução precoce.
			const durável = await handle.conversation.context(context);
			expect(
				durável.entries.filter((entry) => entry.kind === "durable.shell"),
			).toHaveLength(1);
			await closeAgent(handle, context);

			const reopened = await open();
			try {
				const view = await reopened.conversation.context(context);
				const shells = view.entries.filter(
					(entry) => entry.kind === "durable.shell",
				);
				expect(shells).toHaveLength(1);
				expect(shells[0]?.data).toMatchObject({
					exitCode: 0,
					aborted: false,
				});
				expect(
					view.entries.filter((entry) => entry.kind === "pi.user"),
				).toHaveLength(0);
				// Item 9: comando que muda configuração também não roda no fechamento.
				expect((await reopened.conversation.agent(context)).model).toEqual(
					modeloAntes,
				);
			} finally {
				await closeAgent(reopened, context);
			}
		} finally {
			release();
			await rm(dir, { recursive: true, force: true });
		}
	}, 20_000);

	it("commit lento do desfecho não é classificado como interrupção", async () => {
		const dir = await mkdtemp(join(tmpdir(), "durable-tui-slow-commit-"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const handle = await openAgent(
			{
				dbPath: join(dir, "session.sqlite"),
				cwd: dir,
				model: { provider: model.provider, modelId: model.id },
				models,
			},
			context,
		);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		const original = handle.conversation.submit.bind(handle.conversation);
		let writes = 0;
		handle.conversation.submit = (async (
			draft: Parameters<typeof original>[0],
			ctx: Parameters<typeof original>[1],
		) => {
			// Só a primeira escrita atrasa: o fallback de interrupção precisa
			// poder admitir a dele enquanto o commit normal está preso.
			if (draft.type === "write") {
				writes += 1;
				if (writes === 1) await gate;
			}
			return original(draft, ctx);
		});
		try {
			const terminal = new FakeTerminal();
			const running = runTui({ session: handle, context, terminal });
			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");

			terminal.send("!echo devagar");
			terminal.send("\r");
			await waitFor(() => writes === 1, "commit do desfecho pendente");

			terminal.send("/quit");
			terminal.send("\r");
			// A execução já terminou; o commit passa do prazo de 3 s do processo.
			await new Promise((resolveWait) => setTimeout(resolveWait, 3_500));
			release();
			await expect(running).resolves.toEqual({ code: 0 });

			const view = await handle.conversation.context(context);
			const shells = view.entries.filter(
				(entry) => entry.kind === "durable.shell",
			);
			expect(shells).toHaveLength(1);
			expect(shells[0]?.data).toMatchObject({
				exitCode: 0,
				aborted: false,
			});
		} finally {
			release();
			await closeAgent(handle, context);
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("fechamento com descendente que escapou do grupo não pendura a saída", async () => {
		const hasSetsid = await new Promise<boolean>((resolveCheck) => {
			spawn("sh", ["-c", "command -v setsid"], { stdio: "ignore" })
				.on("error", () => resolveCheck(false))
				.on("close", (code) => resolveCheck(code === 0));
		});
		if (!hasSetsid) return;

		const dir = await mkdtemp(join(tmpdir(), "durable-tui-desc-"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const handle = await openAgent(
			{
				dbPath: join(dir, "session.sqlite"),
				cwd: dir,
				model: { provider: model.provider, modelId: model.id },
				models,
			},
			context,
		);
		const marker = `eco${Date.now().toString(36)}`;
		const kill = () => {
			spawn("pkill", ["-f", `echo ${marker}`], { stdio: "ignore" });
		};
		try {
			const terminal = new FakeTerminal();
			const running = runTui({ session: handle, context, terminal });
			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");

			const command = `!setsid bash -c 'while :; do echo ${marker}; sleep 0.02; done' &`;
			for (const char of command) terminal.send(char);
			terminal.send("\r");
			await new Promise((resolveWait) => setTimeout(resolveWait, 600));

			const started = Date.now();
			terminal.send("/quit");
			terminal.send("\r");
			await expect(running).resolves.toEqual({ code: 0 });
			// Item 8: espera limitada, não o processo travado.
			expect(Date.now() - started).toBeLessThan(15_000);
			await closeAgent(handle, context);

			const reopened = await openAgent(
				{
					dbPath: join(dir, "session.sqlite"),
					cwd: dir,
					model: { provider: model.provider, modelId: model.id },
					models,
				},
				context,
			);
			try {
				const view = await reopened.conversation.context(context);
				const shells = view.entries.filter(
					(entry) => entry.kind === "durable.shell",
				);
				expect(shells).toHaveLength(1);
				// Fallback: interrupção sem desfecho, não o cancelamento normal.
				expect(shells[0]?.data).toMatchObject({
					aborted: true,
					exitCode: 130,
					output: "",
				});
			} finally {
				await closeAgent(reopened, context);
			}
		} finally {
			kill();
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("duas entradas seguidas não abrem duas gerações", async () => {
		const dir = await mkdtemp(join(tmpdir(), "durable-tui-guard-"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage("única");
			},
		]);
		const handle = await openAgent(
			{
				dbPath: join(dir, "session.sqlite"),
				cwd: dir,
				model: { provider: model.provider, modelId: model.id },
				models,
			},
			context,
		);
		try {
			const terminal = new FakeTerminal();
			const running = runTui({ session: handle, context, terminal });
			await waitFor(() => terminal.text.includes("ocioso"), "primeiro render");

			terminal.send("um");
			terminal.send("\r");
			terminal.send("dois");
			terminal.send("\r");

			await waitFor(
				() => terminal.text.includes("já existe uma geração"),
				"segunda entrada recusada",
			);
			const mark = terminal.writes.length;
			release();
			await waitFor(
				() => terminal.since(mark).includes("ocioso"),
				"turno encerrado",
			);

			const view = await handle.conversation.context(context);
			expect(
				view.entries.filter((entry) => entry.kind === "pi.user"),
			).toHaveLength(1);

			terminal.send("\u0003");
			await expect(running).resolves.toEqual({ code: 0 });
		} finally {
			release();
			await closeAgent(handle, context);
			await rm(dir, { recursive: true, force: true });
		}
	});
});
