import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import type { Submission } from "@earendil-works/pi-durable";
import { watchEvents } from "@earendil-works/pi-durable";
import {
	Container,
	Editor,
	Markdown,
	ProcessTerminal,
	Spacer,
	Text,
	TuiMainScreen,
	matchesKey,
	type Component,
	type Terminal,
	type TUI,
} from "@earendil-works/pi-tui";

import { submit, watch, type AgentSession } from "../agent/harness.js";
import {
	isThinkingLevel,
	parseModelRef,
	THINKING_LEVELS,
} from "../agent/models.js";
import { runShell } from "../agent/shell.js";
import {
	applyEvents,
	fromSnapshot,
	type Transcript,
	type TranscriptBlock,
} from "./transcript.js";
import { editorTheme, markdownTheme, theme } from "./theme.js";

export type TuiOptions = {
	readonly session: AgentSession;
	readonly context: Context;
	/** Injetáveis para teste; em produção `ProcessTerminal` e `TuiMainScreen`. */
	readonly terminal?: Terminal;
	readonly tui?: TUI;
};

export type TuiExit = {
	readonly code: number;
};

/**
 * TUI do M1: transcript com streaming, editor e abort por `Ctrl+C`.
 *
 * O desenho segue o `watchEvents`: cada lote de eventos redesenha o transcript
 * inteiro, e o terminal faz o diff. Quem submete é o editor; a `Submission`
 * fica guardada para o `Ctrl+C` abortar sem matar o processo.
 */
export async function runTui(options: TuiOptions): Promise<TuiExit> {
	const { session, context } = options;
	const terminal = options.terminal ?? new ProcessTerminal();
	const tui = options.tui ?? new TuiMainScreen(terminal);

	let state: Transcript;
	let busy: Submission | undefined;
	/** `!comando` em execução: `Ctrl+C` cancela o processo filho. */
	let shell: { readonly cancel: () => void } | undefined;
	let exited = false;
	let exitCode = 0;
	let resolveExit: (exit: TuiExit) => void = () => undefined;
	const done = new Promise<TuiExit>((resolve) => {
		resolveExit = resolve;
	});

	const transcript = new Container();
	const status = new Text("", 1, 0);
	const editor = new Editor(tui, editorTheme, { paddingX: 1 });
	const notices: string[] = [];

	let modelLabel = "modelo?";
	let thinkingLevel = "off";

	async function refreshAgent(): Promise<void> {
		const agent = await session.conversation.agent(context);
		modelLabel =
			agent.model === undefined
				? "modelo?"
				: `${agent.model.provider}/${agent.model.modelId}`;
		thinkingLevel = agent.thinkingLevel;
	}

	await refreshAgent();

	function finish(code: number): void {
		if (exited) return;
		exited = true;
		exitCode = code;
		tui.stop();
		resolveExit({ code });
	}

	function render(): void {
		for (const child of [...transcript.children]) transcript.removeChild(child);
		for (const component of componentsOf(state)) transcript.addChild(component);
		for (const text of notices) {
			transcript.addChild(new Text(theme.dim(`· ${text}`), 1, 0));
		}
		status.setText(statusLine());
		tui.requestRender();
	}

	function statusLine(): string {
		const turn =
			busy !== undefined ? "gerando" : shell !== undefined ? "shell" : "ocioso";
		const queue = state.queued > 0 ? ` · fila ${state.queued}` : "";
		const thinking = thinkingLevel === "off" ? "" : ` · ${thinkingLevel}`;
		return theme.dim(
			`${modelLabel}${thinking} · ${turn} · ${state.tokens} tokens${queue}`,
		);
	}

	function notify(text: string): void {
		notices.push(text);
		render();
	}

	async function ask(prompt: string): Promise<void> {
		if (busy !== undefined) {
			notify("já existe uma geração em andamento");
			return;
		}
		try {
			const submission = await submit(session, prompt, context);
			busy = submission;
			render();
			const outcome = await watch(session, submission, context);
			if (outcome.status === "unanswered") {
				notify(`sem resposta: ${outcome.reason ?? "motivo desconhecido"}`);
			}
		} catch (error) {
			notify(`falha na submissão: ${describe(error)}`);
		} finally {
			busy = undefined;
			render();
		}
	}

	async function shellCommand(command: string): Promise<void> {
		if (command === "") {
			notify("uso: !comando");
			return;
		}
		if (shell !== undefined) {
			notify("já existe um comando em execução");
			return;
		}
		// Contexto próprio: `Ctrl+C` cancela o filho sem cancelar a sessão.
		const cancelable = withCancel(context);
		shell = { cancel: cancelable.cancel };
		render();
		try {
			const run = await runShell(session, command, cancelable.context);
			if (run.aborted) notify(`!${command}: abortado`);
		} catch (error) {
			notify(`falha em !${command}: ${describe(error)}`);
		} finally {
			shell = undefined;
			render();
		}
	}

	async function command(text: string): Promise<void> {
		const [rawName, ...rest] = text.slice(1).split(/\s+/);
		const name = rawName ?? "";
		switch (name) {
			case "help":
				notify(
					"comandos: /help, /usage, /compact, /model, /thinking, /quit; " +
						"!comando roda no shell",
				);
				return;
			case "usage":
				notify(`${state.tokens} tokens nesta sessão`);
				return;
			case "compact":
				await session.conversation.compact(undefined, context);
				notify("compactação pedida");
				return;
			case "model": {
				const text = rest.join(" ").trim();
				if (text === "") {
					notify(`modelo atual: ${modelLabel}`);
					return;
				}
				try {
					const model = parseModelRef(text);
					await session.conversation.configure({ model }, context);
					await refreshAgent();
					render();
					notify(`modelo: ${modelLabel}`);
				} catch (error) {
					notify(describe(error));
				}
				return;
			}
			case "thinking": {
				const level = rest.join(" ").trim();
				if (level === "") {
					notify(`nível atual: ${thinkingLevel}`);
					return;
				}
				if (!isThinkingLevel(level)) {
					notify(`nível inválido: ${level} (${THINKING_LEVELS.join(", ")})`);
					return;
				}
				await session.conversation.configure({ thinkingLevel: level }, context);
				await refreshAgent();
				render();
				notify(`raciocínio: ${thinkingLevel}`);
				return;
			}
			case "quit":
			case "exit":
				finish(0);
				return;
			default:
				notify(`comando desconhecido: /${name} ${rest.join(" ")}`.trimEnd());
		}
	}

	editor.onSubmit = (text) => {
		const prompt = text.trim();
		if (prompt === "") return;
		editor.addToHistory(prompt);
		if (prompt.startsWith("/")) void command(prompt);
		else if (prompt.startsWith("!")) void shellCommand(prompt.slice(1).trim());
		else void ask(prompt);
	};

	tui.addInputListener((data) => {
		if (!matchesKey(data, "ctrl+c")) return undefined;
		// Primeiro `Ctrl+C` aborta o que está rodando (geração ou `!comando`);
		// o segundo, sem nada em voo, sai.
		if (busy !== undefined) {
			const submission = busy;
			busy = undefined;
			render();
			void submission
				.abort(context)
				.catch((error: unknown) => notify(describe(error)));
			return { consume: true };
		}
		if (shell !== undefined) {
			shell.cancel();
			notify("cancelando o comando");
			return { consume: true };
		}
		finish(exitCode);
		return { consume: true };
	});

	// Falha de storage encerra o Harness: não há retomada no mesmo processo.
	void session.harness.closed.then((end) => {
		if (end.reason === "failed") {
			process.stderr.write(`sessão falhou: ${describe(end.error)}\n`);
			finish(1);
		}
	});

	const stream = await watchEvents(session.harness, session.conversation.id, context);
	state = fromSnapshot(stream.snapshot);
	stream.start((events) => {
		state = applyEvents(state, events);
		render();
		return Promise.resolve();
	});
	void stream.closed.then((end) => {
		if (end.reason === "listener_error") notify(describe(end.error));
	});

	tui.addChild(transcript);
	tui.addChild(new Spacer(1));
	tui.addChild(status);
	tui.addChild(editor);
	tui.setFocus(editor);
	render();
	tui.start();

	try {
		return await done;
	} finally {
		await stream.stop().catch(() => undefined);
	}
}

function componentsOf(state: Transcript): Component[] {
	const components: Component[] = [];
	for (const block of state.blocks) {
		if (components.length > 0) components.push(new Spacer(1));
		components.push(componentOf(block));
	}
	if (state.streaming !== undefined) {
		if (components.length > 0) components.push(new Spacer(1));
		components.push(
			streamingComponent(state.streaming.text, state.streaming.thinking),
		);
	}
	return components;
}

function componentOf(block: TranscriptBlock): Component {
	switch (block.kind) {
		case "user":
			return new Text(`${theme.bold("›")} ${block.text}`, 1, 0);
		case "assistant":
			return assistantComponent(block.text, block.thinking);
		case "tool":
			return toolComponent(block);
		case "shell": {
			const marker = block.exitCode === 0 ? "✓" : "✗";
			const head = `${marker} ${theme.bold(`!${block.command}`)}`;
			const tail = block.output.trimEnd().split("\n").slice(-20).join("\n");
			return new Text(
				tail === "" ? head : `${head}\n${theme.dim(tail)}`,
				1,
				0,
			);
		}
		case "notice":
			return new Text(theme.dim(`· ${block.text}`), 1, 0);
	}
}

function assistantComponent(text: string, thinking: string): Component {
	return new Markdown(
		thinking === "" ? text : `${theme.dim(thinking)}\n\n${text}`,
		1,
		0,
		markdownTheme,
	);
}

function streamingComponent(text: string, thinking: string): Component {
	return assistantComponent(text, thinking);
}

function toolComponent(
	block: Extract<TranscriptBlock, { kind: "tool" }>,
): Component {
	const marker =
		block.status === "running" ? "…" : block.status === "error" ? "✗" : "✓";
	const head = `${marker} ${block.name}`;
	const tail = block.output.trimEnd().split("\n").slice(-8).join("\n");
	return new Text(
		tail === "" ? theme.dim(head) : `${theme.bold(head)}\n${theme.dim(tail)}`,
		1,
		0,
	);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
