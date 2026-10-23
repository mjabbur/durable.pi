import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import type {
	ProgramStatus,
	Terminal,
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
