import type { Message } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	CompactionEntry,
	ResetEntry,
	ToolResultEntry,
	UserEntry,
	type AgentEvent,
	type EntryRecord,
	type SnapshotEvent,
	type UsageState,
} from "@earendil-works/pi-durable";

/**
 * Um bloco de transcript pronto para desenhar. O reducer é puro e não conhece
 * terminal: a TUI só transforma isto em componentes.
 */
export type TranscriptBlock =
	| { readonly kind: "user"; readonly text: string }
	| {
			readonly kind: "assistant";
			readonly text: string;
			readonly thinking: string;
			readonly streaming: boolean;
	  }
	| {
			readonly kind: "tool";
			readonly callId: string;
			readonly name: string;
			readonly status: "running" | "done" | "error";
			readonly output: string;
	  }
	| { readonly kind: "notice"; readonly text: string };

export type Transcript = {
	readonly blocks: readonly TranscriptBlock[];
	/** Mensagem em voo: existe entre `message_start` e `message_end`. */
	readonly streaming: {
		readonly text: string;
		readonly thinking: string;
	} | undefined;
	/** Entradas já aplicadas, para que `entry_appended` e `message_end` não dupliquem. */
	readonly seen: readonly string[];
	readonly queued: number;
	readonly running: boolean;
	readonly tokens: number;
};

/** Saída de tool retida por bloco; o resto já passou e não volta. */
const MAX_TOOL_OUTPUT = 4_000;

export function emptyTranscript(): Transcript {
	return {
		blocks: [],
		streaming: undefined,
		seen: [],
		queued: 0,
		running: false,
		tokens: 0,
	};
}

/**
 * Estado inicial do stream: o snapshot é o transcript comprometido mais o que
 * está em voo. É por aqui que a TUI retoma depois de um crash.
 */
export function fromSnapshot(snapshot: SnapshotEvent): Transcript {
	let state: Transcript = {
		...emptyTranscript(),
		queued: snapshot.inbox.length,
		running: snapshot.run !== undefined,
		tokens: usageTokens(snapshot.usage),
	};

	for (const entry of snapshot.entries) state = appendEntry(state, entry);

	// Slots ao vivo cobrem a chamada de tool atual, que ainda não tem entrada.
	for (const tool of snapshot.tools) {
		state = upsertTool(state, {
			kind: "tool",
			callId: tool.callId,
			name: tool.name,
			status: tool.status === "done" ? "done" : "running",
			output: tool.output ?? "",
		});
	}

	if (snapshot.generation?.message !== undefined) {
		state = { ...state, streaming: partsOf(snapshot.generation.message) };
	}

	return state;
}

/** Aplica um lote de eventos. O lote é atômico: uma troca de estado por commit. */
export function applyEvents(
	state: Transcript,
	events: readonly AgentEvent[],
): Transcript {
	let next = state;
	for (const event of events) next = applyEvent(next, event);
	return next;
}

function applyEvent(state: Transcript, event: AgentEvent): Transcript {
	switch (event.type) {
		case "snapshot":
			return fromSnapshot(event);
		case "run_start":
			return { ...state, running: true };
		case "run_end":
			return { ...state, running: false };
		case "inbox_update":
			return { ...state, queued: event.items.length };
		case "message_start":
			return event.message.role === "assistant"
				? { ...state, streaming: { text: "", thinking: "" } }
				: state;
		case "message_update": {
			const streaming = state.streaming;
			if (streaming === undefined) return state;
			let text = streaming.text;
			let thinking = streaming.thinking;
			for (const change of event.changes) {
				if (change.type === "text_delta") text += change.delta;
				else if (change.type === "thinking_delta") thinking += change.delta;
			}
			return { ...state, streaming: { text, thinking } };
		}
		case "message_end":
			return appendEntry({ ...state, streaming: undefined }, event.entry);
		case "entry_appended":
			// Uma entrada de assistente também finaliza a mensagem em voo; de tool ou
			// usuário, não — o parcial continua na tela até o `message_end`.
			return appendEntry(
				AssistantEntry.is(event.entry)
					? { ...state, streaming: undefined }
					: state,
				event.entry,
			);
		case "tool_execution_start":
			return upsertTool(state, {
				kind: "tool",
				callId: event.toolCallId,
				name: event.toolName,
				status: "running",
				output: "",
			});
		case "tool_execution_update": {
			const block = toolBlock(state, event.toolCallId);
			if (block === undefined) return state;
			const output = applyToolOutput(block.output, event.output);
			return upsertTool(state, { ...block, output });
		}
		case "tool_execution_end": {
			const block = toolBlock(state, event.toolCallId);
			const result =
				event.entry !== undefined && ToolResultEntry.is(event.entry)
					? event.entry
					: undefined;
			const message = toolResultMessage(result);
			const status =
				event.entry === undefined && event.result === undefined
					? "error"
					: message?.isError === true
						? "error"
						: "done";
			const output =
				block !== undefined && block.output !== ""
					? block.output
					: (message?.text ?? "");
			const type = upsertTool(state, {
				kind: "tool",
				callId: event.toolCallId,
				name: event.toolName,
				status,
				output: clip(output),
			});
			// O resultado também chega como `entry_appended`; marcar evita dois blocos.
			return event.entry === undefined
				? type
				: { ...type, seen: [...type.seen, String(event.entry.id)] };
		}
		case "task_failed":
			return notice(state, `tarefa ${event.kind} falhou: ${event.message}`);
		case "compaction_start":
			return notice(state, "compactando o contexto");
		case "compaction_end":
			return event.error === undefined
				? state
				: notice(state, `compactação falhou: ${event.error}`);
		case "auto_retry_start":
			return notice(
				state,
				`nova tentativa ${event.attempt} após erro: ${event.errorMessage}`,
			);
		case "usage_changed":
			return { ...state, tokens: usageTokens(event.usage) };
		case "agent_changed":
		case "submission":
		case "turn_start":
		case "turn_end":
		case "auto_retry_end":
		case "deferred_poll":
			return state;
	}
}

function appendEntry(state: Transcript, entry: EntryRecord): Transcript {
	const id = String(entry.id);
	if (state.seen.includes(id)) return state;
	const seen = [...state.seen, id];
	const block = blockOf(entry);
	if (block === undefined) return { ...state, seen };
	return { ...state, seen, blocks: [...state.blocks, block] };
}

function blockOf(entry: EntryRecord): TranscriptBlock | undefined {
	const message = entry.model?.[0];
	if (UserEntry.is(entry)) {
		return { kind: "user", text: userText(message) };
	}
	if (AssistantEntry.is(entry)) {
		const parts = partsOf(message);
		if (parts.text === "" && parts.thinking === "") return undefined;
		return { kind: "assistant", ...parts, streaming: false };
	}
	if (ToolResultEntry.is(entry)) {
		const result = toolResultMessage(entry);
		if (result === undefined) return undefined;
		return {
			kind: "tool",
			callId: result.toolCallId,
			name: result.toolName,
			status: result.isError ? "error" : "done",
			output: clip(result.text),
		};
	}
	if (ResetEntry.is(entry)) return { kind: "notice", text: "contexto reiniciado" };
	if (CompactionEntry.is(entry)) {
		return { kind: "notice", text: "contexto compactado" };
	}
	return undefined;
}

function upsertTool(state: Transcript, block: TranscriptBlock): Transcript {
	if (block.kind !== "tool") return state;
	const index = state.blocks.findIndex(
		(candidate) =>
			candidate.kind === "tool" && candidate.callId === block.callId,
	);
	if (index < 0) return { ...state, blocks: [...state.blocks, block] };
	const blocks = [...state.blocks];
	blocks[index] = block;
	return { ...state, blocks };
}

function toolBlock(
	state: Transcript,
	callId: string,
): Extract<TranscriptBlock, { kind: "tool" }> | undefined {
	for (const block of state.blocks) {
		if (block.kind === "tool" && block.callId === callId) return block;
	}
	return undefined;
}

function notice(state: Transcript, text: string): Transcript {
	return {
		...state,
		blocks: [...state.blocks, { kind: "notice", text }],
	};
}

/** `output` de `tool_execution_update`: janela recortada e depois apêndice, ou troca. */
function applyToolOutput(
	current: string,
	output: { trimStart?: number; append?: string } | { set: string } | undefined,
): string {
	if (output === undefined) return current;
	const next = "set" in output ? output.set : current + (output.append ?? "");
	return clip(next);
}

function clip(text: string): string {
	return text.length <= MAX_TOOL_OUTPUT
		? text
		: `…${text.slice(-MAX_TOOL_OUTPUT)}`;
}

function partsOf(
	message: Message | undefined,
): { text: string; thinking: string } {
	if (message?.role !== "assistant") return { text: "", thinking: "" };
	let text = "";
	let thinking = "";
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
		else if (block.type === "thinking") thinking += block.thinking;
	}
	return { text, thinking };
}

function userText(message: Message | undefined): string {
	if (message?.role !== "user") return "";
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
}

type ToolResult = {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly isError: boolean;
	readonly text: string;
};

function toolResultMessage(entry: EntryRecord | undefined): ToolResult | undefined {
	const message = entry?.model?.[0];
	if (message?.role !== "toolResult") return undefined;
	return {
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		isError: message.isError,
		text: message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join(""),
	};
}

function usageTokens(usage: UsageState): number {
	let tokens = 0;
	for (const bucket of [...Object.values(usage.models), ...Object.values(usage.tools)]) {
		const total = bucket["totalTokens"];
		if (typeof total === "number") tokens += total;
	}
	return tokens;
}
