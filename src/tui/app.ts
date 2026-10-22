import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import type { AgentEventStream, Submission } from "@earendil-works/pi-durable";
import { watchEvents } from "@earendil-works/pi-durable";
import {
	Container,
	Editor,
	Markdown,
	ProcessTerminal,
	SelectList,
	Spacer,
	Text,
	TuiMainScreen,
	matchesKey,
	type Component,
	type SelectItem,
	type Terminal,
	type TUI,
} from "@earendil-works/pi-tui";

import { submit, watch, type AgentSession } from "../agent/harness.js";
import {
	isThinkingLevel,
	parseModelRef,
	THINKING_LEVELS,
} from "../agent/models.js";
import type { SessionInfo } from "../agent/sessions.js";
import { runShell } from "../agent/shell.js";
import {
	applyEvents,
	fromSnapshot,
	type Transcript,
	type TranscriptBlock,
} from "./transcript.js";
import { editorTheme, markdownTheme, theme } from "./theme.js";

export type SwitchedSession = {
	readonly session: AgentSession;
	readonly id: string;
};

/**
 * Troca de sessão é do dono do storage, não da TUI: abrir e fechar Harness mora
 * no `main()`. A TUI só pede e desenha o resultado.
 */
export type SessionSwitcher = {
	readonly list: () => Promise<readonly SessionInfo[]>;
	readonly open: (id: string) => Promise<SwitchedSession>;
	readonly create: () => Promise<SwitchedSession>;
};

export type TuiOptions = {
	readonly session: AgentSession;
	readonly context: Context;
	/** Sem switcher (sessão efêmera), `/new` e `/resume` ficam indisponíveis. */
	readonly sessions?: SessionSwitcher;
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
	const { context, sessions } = options;
	const terminal = options.terminal ?? new ProcessTerminal();
	const tui = options.tui ?? new TuiMainScreen(terminal);

	/** Sessão atual; muda em `/new` e `/resume`. */
	let current = options.session;
	let stream: AgentEventStream | undefined;
	/** Descarta eventos de um stream que já foi trocado. */
	let attachment = 0;

	let state: Transcript = fromSnapshot(emptySnapshot());
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
		const agent = await current.conversation.agent(context);
		modelLabel =
			agent.model === undefined
				? "modelo?"
				: `${agent.model.provider}/${agent.model.modelId}`;
		thinkingLevel = agent.thinkingLevel;
	}

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

	/** Para de observar a sessão atual. Necessário antes de trocar de banco. */
	async function detach(): Promise<void> {
		const active = stream;
		stream = undefined;
		attachment += 1;
		await active?.stop().catch(() => undefined);
	}

	/** Passa a desenhar outra sessão (a mesma, depois de uma troca). */
	async function attach(next: AgentSession, label?: string): Promise<void> {
		await detach();
		const token = attachment;
		current = next;
		notices.length = 0;

		const nextStream = await watchEvents(
			next.harness,
			next.conversation.id,
			context,
		);
		stream = nextStream;
		state = fromSnapshot(nextStream.snapshot);

		nextStream.start((events) => {
			if (token !== attachment) return Promise.resolve();
			state = applyEvents(state, events);
			render();
			return Promise.resolve();
		});
		void nextStream.closed.then((end) => {
			if (token !== attachment) return;
			if (end.reason === "listener_error") notify(describe(end.error));
		});
		// Falha de storage encerra o Harness: não há retomada no mesmo processo.
		void next.harness.closed.then((end) => {
			if (token !== attachment) return;
			if (end.reason === "failed") {
				process.stderr.write(`sessão falhou: ${describe(end.error)}\n`);
				finish(1);
			}
		});

		await refreshAgent();
		if (label !== undefined) notices.push(label);
		render();
	}

	async function ask(prompt: string): Promise<void> {
		if (busy !== undefined) {
			notify("já existe uma geração em andamento");
			return;
		}
		const session = current;
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
			const run = await runShell(current, command, cancelable.context);
			if (run.aborted) notify(`!${command}: abortado`);
		} catch (error) {
			notify(`falha em !${command}: ${describe(error)}`);
		} finally {
			shell = undefined;
			render();
		}
	}

	/**
	 * Troca de sessão: para de observar, pede a troca ao dono do storage e
	 * reata. Se a abertura falhar, volta para a sessão anterior, que só é
	 * fechada depois que a nova abriu.
	 */
	async function switchSession(
		open: (switcher: SessionSwitcher) => Promise<SwitchedSession>,
	): Promise<void> {
		if (sessions === undefined) {
			notify("sessão efêmera (--no-session): /new e /resume indisponíveis");
			return;
		}
		const previous = current;
		await detach();
		try {
			const switched = await open(sessions);
			await attach(switched.session, `sessão ${switched.id}`);
		} catch (error) {
			notify(`falha ao trocar de sessão: ${describe(error)}`);
			await attach(previous).catch(() => undefined);
		}
	}

	async function resumePicker(switcher: SessionSwitcher): Promise<void> {
		const list = await switcher.list();
		if (list.length === 0) {
			notify("nenhuma sessão salva");
			return;
		}
		const items: SelectItem[] = list.map((session) => ({
			value: session.id,
			label: session.id,
			description: formatWhen(session.modifiedAt),
		}));
		const picker = new SelectList(
			items,
			Math.min(items.length, 10),
			editorTheme.selectList,
		);
		const overlay = tui.showOverlay(picker, {
			anchor: "center",
			maxHeight: "60%",
		});
		picker.onSelect = (item) => {
			overlay.hide();
			tui.setFocus(editor);
			void switchSession((switcher) => switcher.open(item.value));
		};
		picker.onCancel = () => {
			overlay.hide();
			tui.setFocus(editor);
		};
	}

	async function command(text: string): Promise<void> {
		const [rawName, ...rest] = text.slice(1).split(/\s+/);
		const name = rawName ?? "";
		switch (name) {
			case "help":
				notify(
					"comandos: /help, /usage, /compact, /model, /thinking, /new, " +
						"/resume, /quit; !comando roda no shell",
				);
				return;
			case "usage":
				notify(`${state.tokens} tokens nesta sessão`);
				return;
			case "compact":
				await current.conversation.compact(undefined, context);
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
					await current.conversation.configure({ model }, context);
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
				await current.conversation.configure(
					{ thinkingLevel: level },
					context,
				);
				await refreshAgent();
				render();
				notify(`raciocínio: ${thinkingLevel}`);
				return;
			}
			case "new":
				await switchSession((switcher) => switcher.create());
				return;
			case "resume": {
				if (sessions === undefined) {
					notify("sessão efêmera (--no-session): /new e /resume indisponíveis");
					return;
				}
				const id = rest[0];
				if (id === undefined) {
					await resumePicker(sessions);
					return;
				}
				await switchSession((switcher) => switcher.open(id));
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

	tui.addChild(transcript);
	tui.addChild(new Spacer(1));
	tui.addChild(status);
	tui.addChild(editor);
	tui.setFocus(editor);

	await attach(current);
	tui.start();

	try {
		return await done;
	} finally {
		await detach();
	}
}

function emptySnapshot(): Parameters<typeof fromSnapshot>[0] {
	return {
		type: "snapshot",
		entries: [],
		tools: [],
		nestedTools: [],
		compactions: [],
		inbox: [],
		agent: {},
		usage: { models: {}, tools: {} },
	};
}

function formatWhen(modifiedAt: number): string {
	return new Date(modifiedAt).toISOString().slice(0, 16).replace("T", " ");
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
