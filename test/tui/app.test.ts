import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});
