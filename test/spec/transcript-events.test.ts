import { describe, expect, it } from "vitest";
import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import {
	applyEvents,
	emptyTranscript,
	fromSnapshot,
} from "../../src/tui/transcript.js";

function assistantMessage(text: string, thinking = "") {
	return {
		role: "assistant",
		content: [
			...(thinking === "" ? [] : [{ type: "thinking", thinking }]),
			...(text === "" ? [] : [{ type: "text", text }]),
		],
		api: "openai-completions",
		provider: "test",
		model: "m",
		usage: { input: 0, output: 0 },
		stopReason: "stop",
		timestamp: 0,
	};
}

function assistantEntry(id: number, text: string) {
	return {
		id,
		conversationId: 1,
		kind: "pi.assistant",
		model: [assistantMessage(text)],
	};
}

function toolResultEntry(
	id: number,
	callId: string,
	text: string,
	isError: boolean,
) {
	return {
		id,
		conversationId: 1,
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: callId,
				toolName: "read",
				content: [{ type: "text", text }],
				isError,
				timestamp: 0,
			},
		],
	};
}

function baseSnapshot(
	overrides: Record<string, unknown> = {},
): SnapshotEvent {
	return {
		type: "snapshot",
		entries: [],
		tools: [],
		nestedTools: [],
		compactions: [],
		inbox: [],
		agent: {},
		usage: { models: {}, tools: {} },
		...overrides,
	} as unknown as SnapshotEvent;
}

function event(value: unknown): AgentEvent {
	return value as AgentEvent;
}

describe("transcript reducer", () => {
	it("1: message_start inicia o parcial com o conteúdo da mensagem", () => {
		const state = applyEvents(emptyTranscript(), [
			event({
				type: "message_start",
				message: assistantMessage("hello"),
			}),
		]);
		expect(state.streaming).toEqual({ text: "hello", thinking: "" });
	});

	it("2: message_update com text_start usa o block como conteúdo inicial", () => {
		const state = applyEvents(emptyTranscript(), [
			event({
				type: "message_start",
				message: assistantMessage(""),
			}),
			event({
				type: "message_update",
				usage: {},
				changes: [
					{
						type: "text_start",
						contentIndex: 0,
						block: { type: "text", text: "seed" },
					},
				],
			}),
		]);
		expect(state.streaming?.text).toBe("seed");
	});

	it("3: message_update com block substitui o bloco do contentIndex", () => {
		const state = applyEvents(emptyTranscript(), [
			event({
				type: "message_start",
				message: assistantMessage(""),
			}),
			event({
				type: "message_update",
				usage: {},
				changes: [
					{
						type: "text_start",
						contentIndex: 0,
						block: { type: "text", text: "old" },
					},
				],
			}),
			event({
				type: "message_update",
				usage: {},
				changes: [
					{
						type: "block",
						contentIndex: 0,
						block: { type: "text", text: "new" },
					},
				],
			}),
		]);
		expect(state.streaming?.text).toBe("new");
	});

	it("4: message_update com message substitui o parcial inteiro", () => {
		const state = applyEvents(emptyTranscript(), [
			event({ type: "message_start", message: assistantMessage("stale") }),
			event({
				type: "message_update",
				usage: {},
				changes: [{ type: "message", message: assistantMessage("fresh") }],
			}),
		]);
		expect(state.streaming).toEqual({ text: "fresh", thinking: "" });
	});

	it("5: deltas acumulam no contentIndex certo; text e thinking somam por índice", () => {
		const state = applyEvents(emptyTranscript(), [
			event({ type: "message_start", message: assistantMessage("") }),
			event({
				type: "message_update",
				usage: {},
				changes: [
					{
						type: "thinking_start",
						contentIndex: 1,
						block: { type: "thinking", thinking: "h0" },
					},
					{
						type: "text_start",
						contentIndex: 0,
						block: { type: "text", text: "a" },
					},
				],
			}),
			event({
				type: "message_update",
				usage: {},
				changes: [
					{ type: "text_delta", contentIndex: 0, delta: "b" },
					{ type: "thinking_delta", contentIndex: 1, delta: "h1" },
				],
			}),
		]);
		expect(state.streaming).toEqual({ text: "ab", thinking: "h0h1" });
	});

	it("6: message_end remove o parcial e acrescenta o bloco final", () => {
		const state = applyEvents(emptyTranscript(), [
			event({ type: "message_start", message: assistantMessage("live") }),
			event({ type: "message_end", entry: assistantEntry(7, "final") }),
		]);
		expect(state.streaming).toBeUndefined();
		expect(state.blocks).toHaveLength(1);
		expect(state.blocks[0]).toMatchObject({ kind: "assistant", text: "final" });
	});

	it("7: tool_execution_update com trimStart/append corta e acrescenta; com set substitui", () => {
		const started = applyEvents(emptyTranscript(), [
			event({
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "read",
				args: {},
			}),
			event({
				type: "tool_execution_update",
				toolCallId: "c1",
				toolName: "read",
				output: { set: "abcdef" },
			}),
		]);
		expect(started.blocks[0]).toMatchObject({
			kind: "tool",
			output: "abcdef",
		});
		const trimmed = applyEvents(started, [
			event({
				type: "tool_execution_update",
				toolCallId: "c1",
				toolName: "read",
				output: { trimStart: 2, append: "XY" },
			}),
		]);
		expect(trimmed.blocks[0]).toMatchObject({ kind: "tool", output: "cdefXY" });
	});

	it("8: fromSnapshot não sobrescreve resultado de erro já lido com slot done", () => {
		const snapshot = baseSnapshot({
			entries: [toolResultEntry(3, "c1", "boom output", true)],
			tools: [{ callId: "c1", name: "read", status: "done", output: "ok" }],
		});
		const state = fromSnapshot(snapshot);
		expect(state.blocks).toHaveLength(1);
		expect(state.blocks[0]).toMatchObject({
			kind: "tool",
			status: "error",
			output: "boom output",
		});
	});

	it("9: fromSnapshot mostra o parcial de generation.message", () => {
		const snapshot = baseSnapshot({
			generation: { attempt: 1, message: assistantMessage("partial") },
		});
		expect(fromSnapshot(snapshot).streaming).toEqual({
			text: "partial",
			thinking: "",
		});
	});

	it("10: applyEvents é puro e não muta o estado recebido", () => {
		const before = emptyTranscript();
		const frozen = JSON.stringify(before);
		const next = applyEvents(before, [
			event({ type: "message_start", message: assistantMessage("x") }),
		]);
		expect(next).not.toBe(before);
		expect(JSON.stringify(before)).toBe(frozen);
		expect(before.streaming).toBeUndefined();
	});
});
