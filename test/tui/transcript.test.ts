import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
	watchEvents,
	type AgentEvent,
	type SnapshotEvent,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import {
	ask,
	closeAgent,
	openAgent,
	type AgentSession,
} from "../../src/agent/harness.js";
import {
	applyEvents,
	emptyTranscript,
	fromSnapshot,
} from "../../src/tui/transcript.js";

const context = BACKGROUND_CONTEXT;

/**
 * Roda uma sessão contra SQLite real e modelo faux, coletando os lotes de
 * eventos. O reducer é testado com os eventos que o Harness realmente emite,
 * não com objetos inventados.
 */
async function runWithEvents(
	responses: FauxResponseStep[],
	prompt: string,
): Promise<{
	session: AgentSession;
	batches: AgentEvent[][];
	snapshot: SnapshotEvent;
}> {
	const dir = await mkdtemp(join(tmpdir(), "durable-tui-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const session = await openAgent(
		{
			dbPath: join(dir, "session.sqlite"),
			cwd: dir,
			model: { provider: model.provider, modelId: model.id },
			models,
		},
		context,
	);
	faux.setResponses(responses);

	const stream = await watchEvents(
		session.harness,
		session.conversation.id,
		context,
	);
	const batches: AgentEvent[][] = [];
	stream.start((events) => {
		batches.push([...events]);
		return Promise.resolve();
	});

	await ask(session, prompt, context);
	await stream.stop();
	await rm(dir, { recursive: true, force: true });
	return { session, batches, snapshot: stream.snapshot };
}

function flatten(batches: readonly AgentEvent[][]): AgentEvent[] {
	return batches.flat();
}

describe("transcript da TUI", () => {
	it("snapshot sem histórico começa vazio e mostra o parcial em voo", async () => {
		const { session, snapshot } = await runWithEvents(
			[fauxAssistantMessage("primeira resposta")],
			"primeira pergunta",
		);
		try {
			expect(fromSnapshot(snapshot).blocks).toEqual([]);

			// Mesmo snapshot com um parcial: é o caso de reabrir no meio da geração.
			const comParcial = fromSnapshot({
				...snapshot,
				generation: { attempt: 1, message: mensagemParcial("meio da resp") },
			});
			expect(comParcial.streaming).toEqual({
				text: "meio da resp",
				thinking: "",
			});
		} finally {
			await closeAgent(session, context);
		}
	});

	it("deltas de texto acumulam na mensagem em voo", () => {
		// O provedor faux entrega a mensagem inteira de uma vez, então os deltas
		// são montados à mão: é o formato que `message_update` traz.
		const parcial = mensagemParcial("");
		const estado = applyEvents(emptyTranscript(), [
			{ type: "message_start", message: parcial },
			{
				type: "message_update",
				usage: parcial.usage,
				changes: [{ type: "text_delta", contentIndex: 0, delta: "resp" }],
			},
			{
				type: "message_update",
				usage: parcial.usage,
				changes: [{ type: "text_delta", contentIndex: 0, delta: "osta" }],
			},
		]);
		expect(estado.streaming).toEqual({ text: "resposta", thinking: "" });
		expect(estado.blocks).toEqual([]);
	});

	it("`entry_appended` e `message_end` da mesma resposta não duplicam", async () => {
		const { session, batches, snapshot } = await runWithEvents(
			[fauxAssistantMessage("resposta final")],
			"pergunta",
		);
		try {
			const final = applyEvents(fromSnapshot(snapshot), flatten(batches));
			const assistentes = final.blocks.filter(
				(block) => block.kind === "assistant",
			);
			expect(assistentes).toHaveLength(1);
			expect(assistentes[0]).toMatchObject({
				text: "resposta final",
				streaming: false,
			});
			expect(final.streaming).toBeUndefined();
			expect(final.blocks.filter((block) => block.kind === "user")).toHaveLength(
				1,
			);
		} finally {
			await closeAgent(session, context);
		}
	});

	it("chamada de tool vira um único bloco com o status do resultado", async () => {
		const { session, batches, snapshot } = await runWithEvents(
			[
				fauxAssistantMessage(
					[
						fauxToolCall("write", {
							path: "saida.txt",
							content: "olá\n",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("escrevi o arquivo"),
			],
			"escreva saida.txt",
		);
		try {
			const final = applyEvents(fromSnapshot(snapshot), flatten(batches));
			const tools = final.blocks.filter((block) => block.kind === "tool");
			// `tool_execution_end` e `entry_appended` descrevem a mesma chamada.
			expect(tools).toHaveLength(1);
			expect(tools[0]).toMatchObject({ name: "write", status: "done" });
		} finally {
			await closeAgent(session, context);
		}
	});

	it("turno e nova tentativa aparecem no estado, sem virar bloco de tool", () => {
		const estado = applyEvents(emptyTranscript(), [
			{ type: "run_start", inputs: [] },
			{
				type: "auto_retry_start",
				attempt: 2,
				at: 0,
				errorMessage: "provedor fora do ar",
			},
			{ type: "run_end", inputs: [] },
		]);
		expect(estado.running).toBe(false);
		expect(estado.blocks).toEqual([
			{
				kind: "notice",
				text: "nova tentativa 2 após erro: provedor fora do ar",
			},
		]);
	});
});

/** Mensagem mínima de assistente, como o provedor a entrega durante o streaming. */
function mensagemParcial(texto: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: texto }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 0,
	};
}
