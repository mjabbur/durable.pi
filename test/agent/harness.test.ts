import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
	ask,
	closeAgent,
	openAgent,
	submit,
	watch,
} from "../../src/agent/harness.js";

const context = BACKGROUND_CONTEXT;

async function withDir(run: (dir: string, dbPath: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "durable-agent-"));
	try {
		await run(dir, join(dir, "session.sqlite"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Harness sobre SQLite real, modelo falso: nenhuma rede no teste. */
async function openFake(dir: string, dbPath: string) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const session = await openAgent(
		{
			dbPath,
			cwd: dir,
			model: { provider: model.provider, modelId: model.id },
			models,
		},
		context,
	);
	return { session, faux };
}

describe("openAgent", () => {
	it("executa a tool write e devolve o texto final", async () => {
		await withDir(async (dir, dbPath) => {
			const { session, faux } = await openFake(dir, dbPath);
			faux.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("write", { path: "hello.txt", content: "olá\n" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("pronto"),
			]);

			const outcome = await ask(session, "crie hello.txt", context);

			expect(outcome).toMatchObject({ status: "done", answer: "pronto" });
			expect(await readFile(join(dir, "hello.txt"), "utf8")).toBe("olá\n");
			const view = await session.conversation.context(context);
			const kinds = view.entries.map((entry) => entry.kind);
			expect(kinds).toContain("pi.user");
			expect(kinds).toContain("pi.assistant");
			expect(kinds).toContain("pi.tool-result");
			await closeAgent(session, context);
		});
	});

	it("persiste o transcript e o modelo vê o histórico ao reabrir", async () => {
		await withDir(async (dir, dbPath) => {
			const first = await openFake(dir, dbPath);
			first.faux.setResponses([fauxAssistantMessage("primeira resposta")]);
			await ask(first.session, "primeira pergunta", context);
			const antes = await first.session.conversation.context(context);
			const resumo = antes.entries.map((entry) => `${entry.kind}:${entry.id}`);
			await closeAgent(first.session, context);

			const second = await openFake(dir, dbPath);
			const depois = await second.session.conversation.context(context);
			expect(depois.entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(
				resumo,
			);

			// A segunda geração recebe o histórico da primeira, não só o novo prompt.
			let vistos = 0;
			let texto = "";
			second.faux.setResponses([
				(mensagens) => {
					vistos = mensagens.messages.length;
					texto = JSON.stringify(mensagens.messages);
					return fauxAssistantMessage("segunda resposta");
				},
			]);
			await ask(second.session, "segunda pergunta", context);

			expect(vistos).toBeGreaterThan(antes.messages.length);
			expect(texto).toContain("primeira pergunta");
			await closeAgent(second.session, context);
		});
	});

	it("separa admissão (submit) de espera (watch)", async () => {
		await withDir(async (dir, dbPath) => {
			const { session, faux } = await openFake(dir, dbPath);
			faux.setResponses([fauxAssistantMessage("resposta")]);

			const submission = await submit(session, "primeiro passo", context);
			// Admitido: o input já está no transcript antes de esperar a resposta.
			const durante = await session.conversation.context(context);
			expect(
				durante.entries.some((entry) => entry.kind === "pi.user"),
			).toBe(true);

			const outcome = await watch(session, submission, context);
			expect(outcome).toMatchObject({ status: "done", answer: "resposta" });
			await closeAgent(session, context);
		});
	});

	it("requestId explícito não colapsa prompts iguais de clientes distintos", async () => {
		await withDir(async (dir, dbPath) => {
			const { session, faux } = await openFake(dir, dbPath);
			faux.setResponses([
				fauxAssistantMessage("da web"),
				fauxAssistantMessage("do cli"),
			]);

			const daWeb = await submit(session, "oi", context, "cliente-web-1");
			const doCli = await submit(session, "oi", context, "cliente-cli-1");

			expect(daWeb.id).not.toBe(doCli.id);
			expect(await watch(session, daWeb, context)).toMatchObject({
				status: "done",
			});
			expect(await watch(session, doCli, context)).toMatchObject({
				status: "done",
			});

			const view = await session.conversation.context(context);
			const usuarios = view.entries.filter((entry) => entry.kind === "pi.user");
			expect(usuarios.length).toBe(2);
			await closeAgent(session, context);
		});
	});

	it("mesmo requestId devolve a mesma submissão", async () => {
		await withDir(async (dir, dbPath) => {
			const { session, faux } = await openFake(dir, dbPath);
			faux.setResponses([fauxAssistantMessage("uma só")]);

			const primeira = await submit(session, "oi", context, "id-fixo");
			await watch(session, primeira, context);
			const segunda = await submit(session, "oi", context, "id-fixo");

			expect(segunda.id).toBe(primeira.id);
			await closeAgent(session, context);
		});
	});

	it("recusa reabrir a sessão de outro diretório", async () => {
		await withDir(async (dir, dbPath) => {
			const first = await openFake(dir, dbPath);
			first.faux.setResponses([fauxAssistantMessage("ok")]);
			await ask(first.session, "oi", context);
			await closeAgent(first.session, context);

			const outro = join(dir, "outro");
			await mkdir(outro, { recursive: true });
			await expect(openFake(outro, dbPath)).rejects.toThrow(/vinculada a/);
		});
	});

	it("aplica o modelo efetivo da execução, sem virar default da sessão", async () => {
		await withDir(async (dir, dbPath) => {
			const a = fauxProvider({ provider: "faux-a" }).getModel();
			const b = fauxProvider({ provider: "faux-b" }).getModel();
			const models = createModels();
			models.setProvider(fauxProvider({ provider: "faux-a" }).provider);
			models.setProvider(fauxProvider({ provider: "faux-b" }).provider);
			const refA = { provider: a.provider, modelId: a.id };
			const refB = { provider: b.provider, modelId: b.id };

			const modeloDe = async (model: typeof refA) => {
				const session = await openAgent({ dbPath, cwd: dir, model, models }, context);
				const agente = await session.conversation.agent(context);
				await closeAgent(session, context);
				return agente.model;
			};

			expect(await modeloDe(refA)).toEqual(refA);
			// Execução com --model diferente não muda a próxima.
			expect(await modeloDe(refB)).toEqual(refB);
			expect(await modeloDe(refA)).toEqual(refA);
		});
	});

	it("reporta desfecho sem resposta quando o modelo falha", async () => {
		await withDir(async (dir, dbPath) => {
			const { session, faux } = await openFake(dir, dbPath);
			faux.setResponses([
				fauxAssistantMessage("x", {
					stopReason: "error",
					errorMessage: "provedor fora do ar",
				}),
			]);

			const outcome = await ask(session, "oi", context);

			expect(outcome.status).toBe("unanswered");
			expect(outcome.reason).toBeDefined();
			await closeAgent(session, context);
		});
	});
});
