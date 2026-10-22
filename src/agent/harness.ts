import { randomUUID } from "node:crypto";

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	createRegistry,
	Harness,
	type Conversation,
	type EntryRecord,
	type ModelRef,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import { createAgentModels } from "./models.js";

/**
 * Prompt padrão. Instruções de projeto (`AGENTS.md`) entram no M2; até lá o
 * agente só sabe o que está aqui e o que a tool `read` devolver.
 */
export const DEFAULT_INSTRUCTIONS = [
	"Você é um agente de código rodando sobre um harness durável.",
	"Use as tools para inspecionar e alterar arquivos. Prefira editar a reescrever.",
	"Responda curto: o que mudou, o que falhou, e o próximo passo.",
].join("\n");

export type AgentOptions = {
	readonly dbPath: string;
	readonly cwd: string;
	readonly model: ModelRef;
	readonly instructions?: string;
	/** Injetável para teste; em produção, o catálogo do pi-ai. */
	readonly models?: Models;
};

export type AgentSession = {
	readonly harness: Harness;
	readonly conversation: Conversation;
};

export type AskOutcome = {
	readonly submissionId: SubmissionId;
	readonly status: "done" | "unanswered";
	readonly answer?: string;
	readonly reason?: string;
};

/** Registro de tools do agente: as quatro de código, nada além disso no M0. */
export function createAgentRegistry() {
	const registry = createRegistry();
	registry.install(CodingTools);
	return registry;
}

/**
 * Abre o Harness sobre um arquivo SQLite e devolve a conversa raiz já
 * configurada. Um processo por storage: quem chama isto é dono do arquivo.
 */
export async function openAgent(
	options: AgentOptions,
	context: Context,
): Promise<AgentSession> {
	const storage = await openNodeSqliteStorage(options.dbPath);

	// Cada aquisição tem dono: se o passo seguinte falhar, o anterior é liberado
	// com contexto não cancelado, para não deixar SQLite aberto no processo.
	let harness: Harness;
	try {
		harness = await Harness.open(
			storage,
			{
				models: options.models ?? createAgentModels(),
				registry: createAgentRegistry(),
				env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.cwd }),
			},
			context,
		);
	} catch (error) {
		await storage.close(BACKGROUND_CONTEXT).catch(() => undefined);
		throw error;
	}

	let conversation: Conversation;
	try {
		conversation = await harness.root(context, {
			agent: {
				model: options.model,
				instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
			},
		});
	} catch (error) {
		await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
		throw error;
	}

	return { harness, conversation };
}

/**
 * Submete o prompt e espera o desfecho. O `requestId` é gerado uma vez: reenviar
 * a mesma chamada não duplica a entrada.
 */
export async function ask(
	session: AgentSession,
	prompt: string,
	context: Context,
): Promise<AskOutcome> {
	const submission = await session.conversation.submit(
		{ type: "input", content: prompt, requestId: randomUUID() },
		context,
	);
	const settled = await submission.wait(context);

	if (settled.status !== "done") {
		return {
			submissionId: submission.id,
			status: "unanswered",
			reason: settled.reason,
		};
	}

	const answerId = settled.answer;
	if (answerId === undefined) {
		return {
			submissionId: submission.id,
			status: "unanswered",
			reason: "submission concluída sem resposta",
		};
	}

	const entry = await session.conversation.commit(
		(tx) => tx.entry(AssistantEntry, answerId),
		context,
	);
	const answer = assistantText(entry);
	return answer === undefined
		? { submissionId: submission.id, status: "done" }
		: { submissionId: submission.id, status: "done", answer };
}

export async function closeAgent(
	session: AgentSession,
	context: Context,
): Promise<void> {
	await session.harness.close(context);
}

/** Texto da resposta final; pensamento e tool calls ficam de fora. */
function assistantText(entry: EntryRecord | undefined): string | undefined {
	const message = entry?.model?.[0];
	if (message === undefined || message.role !== "assistant") return undefined;
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	return text === "" ? undefined : text;
}
