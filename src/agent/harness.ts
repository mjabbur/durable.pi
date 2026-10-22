import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

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
	type Submission,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import { Control } from "./control.js";
import { acquireStorageLock, type StorageLock } from "./lock.js";
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
	readonly lock: StorageLock;
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
 * configurada. Um processo por storage: o lock é o que garante isso.
 *
 * A sessão fica vinculada ao `cwd` da criação; reabrir de outro diretório
 * falha, porque o alvo das tools mudaria em silêncio. O modelo recebido é o
 * efetivo da execução e é aplicado via `configure()` quando difere do gravado,
 * porque `root(..., { agent })` só vale na criação. Default de modelo mora no
 * arquivo de config, não na sessão.
 */
export async function openAgent(
	options: AgentOptions,
	context: Context,
): Promise<AgentSession> {
	const lock = await acquireStorageLock(options.dbPath);

	try {
		const storage = await openNodeSqliteStorage(options.dbPath);

		// Cada aquisição tem dono: se o passo seguinte falhar, o anterior é
		// liberado com contexto não cancelado, sem deixar SQLite aberto.
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
					cwd: options.cwd,
				},
			});
		} catch (error) {
			await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
			throw error;
		}

		const agent = await conversation.agent(context);
		if (
			agent.cwd !== undefined &&
			resolve(agent.cwd) !== resolve(options.cwd)
		) {
			await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
			throw new Error(
				`sessão vinculada a ${agent.cwd}; aberta em ${options.cwd}. ` +
					"Rode do diretório original ou comece outra sessão.",
			);
		}
		if (
			agent.model === undefined ||
			agent.model.provider !== options.model.provider ||
			agent.model.modelId !== options.model.modelId
		) {
			await conversation.configure({ model: options.model }, context);
		}

		return { harness, conversation, lock };
	} catch (error) {
		await lock.release().catch(() => undefined);
		throw error;
	}
}

/**
 * Admite o prompt e devolve a submissão, sem esperar resposta.
 *
 * A intenção (`requestId` + prompt) é commitada antes de submeter. Sem
 * `requestId` explícito, um prompt idêntico ao pendente reaproveita o id, para
 * que a reexecução do mesmo comando depois de um crash devolva a submissão
 * existente em vez de admitir um segundo input. Um cliente de vida longa (TUI,
 * servidor web) passa o `requestId` que ele mesmo guarda: assim dois prompts
 * iguais de clientes diferentes não colapsam num só.
 */
export async function submit(
	session: AgentSession,
	prompt: string,
	context: Context,
	requestId?: string,
): Promise<Submission> {
	const { conversation } = session;

	const id = await conversation.commit(async (tx) => {
		const control = await tx.doc(Control, conversation.id);
		if (requestId !== undefined) {
			if (control.pending?.requestId !== requestId) {
				control.pending = { requestId, prompt };
			}
			return requestId;
		}
		const pending = control.pending;
		if (pending !== null && pending.prompt === prompt) return pending.requestId;

		const fresh = randomUUID();
		control.pending = { requestId: fresh, prompt };
		return fresh;
	}, context);

	return conversation.submit(
		{ type: "input", content: prompt, requestId: id },
		context,
	);
}

/** Espera o desfecho da submissão, lê a resposta e limpa a intenção pendente. */
export async function watch(
	session: AgentSession,
	submission: Submission,
	context: Context,
): Promise<AskOutcome> {
	const { conversation } = session;
	const settled = await submission.wait(context);
	const requestId = settled.requestId;

	if (settled.status !== "done") {
		await clearPending(conversation, requestId, context);
		return {
			submissionId: submission.id,
			status: "unanswered",
			reason: settled.reason,
		};
	}

	const answerId = settled.answer;
	if (answerId === undefined) {
		await clearPending(conversation, requestId, context);
		return {
			submissionId: submission.id,
			status: "unanswered",
			reason: "submission concluída sem resposta",
		};
	}

	const entry = await conversation.commit(async (tx) => {
		// Lê a entrada antes de escrever o doc: leitura de tabela depois de
		// escrita na mesma transação lança ReadAfterWrite.
		const answer = await tx.entry(AssistantEntry, answerId);
		const control = await tx.doc(Control, conversation.id);
		if (requestId !== undefined && control.pending?.requestId === requestId) {
			control.pending = null;
		}
		return answer;
	}, context);

	const answer = assistantText(entry);
	return answer === undefined
		? { submissionId: submission.id, status: "done" }
		: { submissionId: submission.id, status: "done", answer };
}

/** Açúcar para o CLI: `submit()` + `watch()`. */
export async function ask(
	session: AgentSession,
	prompt: string,
	context: Context,
	requestId?: string,
): Promise<AskOutcome> {
	const submission = await submit(session, prompt, context, requestId);
	return watch(session, submission, context);
}

export async function closeAgent(
	session: AgentSession,
	context: Context,
): Promise<void> {
	try {
		await session.harness.close(context);
	} finally {
		await session.lock.release();
	}
}

/**
 * Limpa a intenção se ela ainda é a desta submissão. Um `submit` posterior pode
 * ter gravado outra, e apagar a dele faria o próximo crash reenviar input
 * duplicado.
 */
async function clearPending(
	conversation: Conversation,
	requestId: string | undefined,
	context: Context,
): Promise<void> {
	await conversation.commit(async (tx) => {
		const control = await tx.doc(Control, conversation.id);
		if (requestId !== undefined && control.pending?.requestId === requestId) {
			control.pending = null;
		}
	}, context);
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
