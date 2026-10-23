import { randomUUID } from "node:crypto";

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

import {
	resumePendingIntents,
	submit,
	watch,
	type AgentSession,
} from "../agent/harness.js";
import {
	isThinkingLevel,
	parseModelRef,
	THINKING_LEVELS,
} from "../agent/models.js";
import type { SessionInfo } from "../agent/sessions.js";
import {
	commitShell,
	executeShell,
	type ShellRun,
} from "../agent/shell.js";
import {
	applyEvents,
	fromSnapshot,
	type Transcript,
	type TranscriptBlock,
} from "./transcript.js";
import { sanitizeForTerminal } from "./text.js";
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
 * Geração em voo. Reservada antes do primeiro `await` para que duas entradas
 * seguidas não atravessem a guarda; `aborting` mantém o estado até o desfecho.
 */
type Turn = {
	readonly requestId: string;
	submission?: Submission;
	aborting?: boolean;
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
	/** Troca em andamento: sem sessão publicada entre `detach` e `attach`. */
	let switching = false;

	let state: Transcript = fromSnapshot(emptySnapshot());
	let turn: Turn | undefined;
	/** Aborto de geração que não é um `ask()` desta TUI (retomada no attach). */
	let abortingRun = false;
	/**
	 * `!comando` em execução. Guarda a sessão de origem e um `requestId` por
	 * execução: o desfecho normal e o de interrupção disputam a mesma admissão,
	 * e um fechamento tardio nunca grava na sessão errada.
	 */
	type ShellState = {
		readonly command: string;
		readonly session: AgentSession;
		readonly requestId: string;
		readonly cancel: () => void;
		readonly executed: Promise<ShellRun>;
		interrupted: boolean;
		done: Promise<void>;
	};
	let shell: ShellState | undefined;
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

	async function finish(code: number): Promise<void> {
		if (exited) {
			// Falha fatal anunciada durante o fechamento tem precedência sobre 0.
			if (code !== 0) exitCode = code;
			return;
		}
		exited = true;
		exitCode = code;
		try {
			// Fechar com `!comando` em execução não pode largar o filho sem gravar o
			// desfecho: quem fecha a sessão é o dono do storage, logo depois daqui.
			await stopShell();
		} finally {
			// `stop()` pode lançar com terminal quebrado; a saída não pode ficar
			// pendurada por causa da limpeza.
			try {
				tui.stop();
			} finally {
				resolveExit({ code: exitCode });
			}
		}
	}

	/** Prazo para o filho morrer ao fechar; acima disso o desfecho é perdido. */
	const SHELL_SETTLE_MS = 3_000;

	/**
	 * Cancela e conclui o `!comando` em execução.
	 *
	 * O prazo vale só para o **processo** terminar, não para o commit: se a
	 * execução já produziu desfecho, o commit é aguardado sem prazo (é a promessa
	 * de durabilidade). Se o processo não morrer no prazo — descendente que
	 * escapou do grupo e mantém o pipe aberto — registra a interrupção sem
	 * desfecho e segue. As duas escritas usam o mesmo `requestId`, então só uma
	 * entrada existe.
	 */
	async function stopShell(): Promise<void> {
		const active = shell;
		if (active === undefined) return;
		active.cancel();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), SHELL_SETTLE_MS);
		});
		let result: ShellRun | null;
		try {
			result = await Promise.race([
				active.executed.catch(() => null),
				deadline,
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
		if (result !== null) {
			// Processo terminou: o desfecho é o normal, mesmo que o commit demore.
			await active.done.catch(() => undefined);
			return;
		}
		if (active.interrupted) return;
		active.interrupted = true;
		try {
			await commitShell(
				active.session,
				{
					command: active.command,
					exitCode: 130,
					output: "",
					aborted: true,
				},
				active.requestId,
			);
		} catch (error) {
			process.stderr.write(
				`!${active.command}: desfecho não gravado (${describe(error)})\n`,
			);
		}
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
		const turnLabel =
			turn?.aborting === true || abortingRun
				? "cancelando"
				: turn !== undefined || state.running
					? "gerando"
					: shell !== undefined
						? "shell"
						: "ocioso";
		const queue = state.queued > 0 ? ` · fila ${state.queued}` : "";
		const thinking = thinkingLevel === "off" ? "" : ` · ${thinkingLevel}`;
		return theme.dim(
			`${modelLabel}${thinking} · ${turnLabel} · ${state.tokens} tokens${queue}`,
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
		void nextStream.closed
			.then((end) => {
				if (token !== attachment) return;
				if (end.reason === "listener_error") notify(describe(end.error));
			})
			.catch(reportCommandError);
		// Falha de storage encerra o Harness: não há retomada no mesmo processo.
		void next.harness.closed
			.then((end) => {
				if (token !== attachment) return;
				if (end.reason === "failed") {
					process.stderr.write(`sessão falhou: ${describe(end.error)}\n`);
					void finish(1).catch(() => undefined);
				}
			})
			.catch(reportCommandError);

		await refreshAgent();
		// Observar não liga o scheduler: sem `resume()`, uma submissão colocada
		// ou uma task de geração viva fica parada e a tela mente "ocioso".
		next.harness.resume();
		try {
			const resumed = await resumePendingIntents(next, context, {
				stopped: () => exited,
			});
			if (resumed > 0) {
				notices.push(
					resumed === 1
						? "1 pedido pendente retomado"
						: `${resumed} pedidos pendentes retomados`,
				);
			}
		} catch (error) {
			notify(`falha ao retomar pedidos pendentes: ${describe(error)}`);
		}
		if (exited) return;
		if (label !== undefined) notices.push(label);
		render();
	}

	async function ask(prompt: string): Promise<void> {
		if (exited) return;
		if (switching) {
			notify("troca de sessão em andamento");
			return;
		}
		if (turn !== undefined) {
			notify("já existe uma geração em andamento");
			return;
		}
		const session = current;
		// Reserva síncrona: o `await` da admissão não pode abrir a janela em que
		// uma segunda entrada passa pela guarda.
		const mine: Turn = { requestId: randomUUID() };
		turn = mine;
		render();
		try {
			const submission = await submit(
				session,
				prompt,
				context,
				mine.requestId,
			);
			mine.submission = submission;
			const outcome = await watch(session, submission, context);
			if (outcome.status === "unanswered") {
				notify(`sem resposta: ${outcome.reason ?? "motivo desconhecido"}`);
			}
		} catch (error) {
			notify(`falha na submissão: ${describe(error)}`);
		} finally {
			// Só limpa o turno que ainda é o atual: um `finally` atrasado não pode
			// apagar o estado de uma geração posterior.
			if (turn === mine) {
				turn = undefined;
				render();
			}
		}
	}

	async function shellCommand(command: string): Promise<void> {
		if (exited) return;
		if (switching) {
			notify("troca de sessão em andamento");
			return;
		}
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
		const session = current;
		const requestId = randomUUID();
		const executed = executeShell(session, command, cancelable.context);
		const state: ShellState = {
			command,
			session,
			requestId,
			cancel: cancelable.cancel,
			executed,
			interrupted: false,
			done: Promise.resolve(),
		};
		shell = state;
		render();
		const run = (async () => {
			try {
				const result = await executed;
				if (state.interrupted) return;
				await commitShell(session, result, requestId);
				if (result.aborted) notify(`!${command}: abortado`);
			} catch (error) {
				if (!state.interrupted) {
					notify(`falha em !${command}: ${describe(error)}`);
				}
			} finally {
				if (shell === state) {
					shell = undefined;
					render();
				}
			}
		})();
		state.done = run;
		await run;
	}

	/**
	 * Troca de sessão: para de observar, pede a troca ao dono do storage e
	 * reata. A abertura vem antes do fechamento da anterior, então uma falha
	 * ali é recuperável; falha depois da abertura não é — a anterior já não
	 * existe e reatá-la seria desenhar um handle fechado.
	 */
	async function switchSession(
		open: (switcher: SessionSwitcher) => Promise<SwitchedSession>,
	): Promise<void> {
		if (exited) return;
		if (sessions === undefined) {
			notify("sessão efêmera (--no-session): /new e /resume indisponíveis");
			return;
		}
		if (switching) {
			notify("troca de sessão em andamento");
			return;
		}
		// Trocar de banco no meio da geração perderia o turno: o Harness antigo
		// fecha com a submissão em voo e ninguém mais a acompanha.
		if (turn !== undefined) {
			notify("aguarde a geração terminar antes de trocar de sessão");
			return;
		}
		// Reserva síncrona: `stopShell` pode demorar e uma segunda troca não pode
		// atravessar a guarda durante a espera.
		switching = true;
		try {
			// O desfecho do `!comando` pertence à sessão antiga; gravar antes de soltar.
			if (shell !== undefined) await stopShell();
			// O fechamento pode ter começado durante a espera: não monte sessão nova.
			if (exited) return;
			const previous = current;
			await detach();
			if (exited) return;
			let switched: SwitchedSession;
			try {
				switched = await open(sessions);
			} catch (error) {
				if (exited) return;
				// O dono do storage só fecha a anterior depois que a nova abre:
				// aqui ela continua viva e pode voltar a ser desenhada. Se nem isso
				// funcionar, não há stream nem estado confiável: encerra.
				let restored = true;
				await attach(previous).catch((again: unknown) => {
					restored = false;
					const message = `falha ao reanexar a sessão anterior: ${describe(again)}`;
					process.stderr.write(`${message}\n`);
					notify(message);
				});
				if (!restored) {
					await finish(1);
					return;
				}
				notify(`falha ao trocar de sessão: ${describe(error)}`);
				return;
			}
			if (exited) return;
			try {
				await attach(switched.session, `sessão ${switched.id}`);
			} catch (error) {
				const message = `falha ao anexar a sessão ${switched.id}: ${describe(error)}`;
				process.stderr.write(`${message}\n`);
				notify(message);
				await finish(1);
			}
		} finally {
			switching = false;
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
			void switchSession((switcher) => switcher.open(item.value)).catch(
				reportCommandError,
			);
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
				if (switching) {
					notify("troca de sessão em andamento");
					return;
				}
				await current.conversation.compact(undefined, context);
				notify("compactação pedida");
				return;
			case "model": {
				if (switching) {
					notify("troca de sessão em andamento");
					return;
				}
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
				if (switching) {
					notify("troca de sessão em andamento");
					return;
				}
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
				await finish(0);
				return;
			default:
				notify(`comando desconhecido: /${name} ${rest.join(" ")}`.trimEnd());
		}
	}

	editor.onSubmit = (text) => {
		if (exited) return;
		const prompt = text.trim();
		if (prompt === "") return;
		editor.addToHistory(prompt);
		if (prompt.startsWith("/")) void command(prompt).catch(reportCommandError);
		else if (prompt.startsWith("!"))
			void shellCommand(prompt.slice(1).trim()).catch(reportCommandError);
		else void ask(prompt).catch(reportCommandError);
	};

	/**
	 * Fronteira de despacho: comando que rejeita vira aviso, não crash. Depois
	 * da saída não há mais em que avisar: a falha terminal já tem canal próprio
	 * (`harness.closed` → stderr → código 1).
	 */
	function reportCommandError(error: unknown): void {
		if (exited) return;
		notify(describe(error));
	}

	tui.addInputListener((data) => {
		if (!matchesKey(data, "ctrl+c")) return undefined;
		if (exited) return { consume: true };
		// Primeiro `Ctrl+C` aborta a geração, via `conversation.abort()`; o
		// segundo sai só quando não há nada em voo. `Submission.abort()` não serve:
		// ele só retira o que está na fila e devolve `already_placed`.
		if (turn !== undefined) {
			if (turn.aborting === true) {
				notify("cancelando — aguarde o turno terminar");
				return { consume: true };
			}
			turn.aborting = true;
			render();
			const mine = turn;
			void current.conversation.abort(context).catch((error: unknown) => {
				// O turno pode ter terminado enquanto o aborto falhava: não limpe o
				// estado de outro turno, que já tem a própria reserva.
				if (turn !== mine) return;
				mine.aborting = false;
				notify(`falha ao cancelar: ${describe(error)}`);
				render();
			});
			return { consume: true };
		}
		if (shell !== undefined) {
			shell.cancel();
			notify("cancelando o comando");
			return { consume: true };
		}
		// Geração que veio da retomada (submissão que não é deste `ask`) também
		// precisa de aborto explícito, senão o processo fecha com a task viva.
		if (state.running || abortingRun) {
			if (abortingRun) {
				notify("cancelando — aguarde o turno terminar");
				return { consume: true };
			}
			abortingRun = true;
			render();
			void current.conversation
				.abort(context)
				.catch((error: unknown) => notify(`falha ao cancelar: ${describe(error)}`))
				.finally(() => {
					abortingRun = false;
					render();
				});
			return { consume: true };
		}
		void finish(exitCode);
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
			const tail = sanitizeForTerminal(block.output)
				.trimEnd()
				.split("\n")
				.slice(-20)
				.join("\n");
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
	const tail = sanitizeForTerminal(block.output)
		.trimEnd()
		.split("\n")
		.slice(-8)
		.join("\n");
	return new Text(
		tail === "" ? theme.dim(head) : `${theme.bold(head)}\n${theme.dim(tail)}`,
		1,
		0,
	);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
