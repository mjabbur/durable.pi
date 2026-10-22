import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
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
	const dir = await mkdtemp(join(tmpdir(), "handoff-"));
	try {
		await run(dir, join(dir, "session.sqlite"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function openFake(dir: string, dbPath: string, workspace?: string) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const session = await openAgent(
		{
			dbPath,
			cwd: dir,
			...(workspace === undefined ? {} : { workspace }),
			model: { provider: model.provider, modelId: model.id },
			models,
		},
		context,
	);
	return { session, faux };
}

/** Textos das entradas `pi.user` que contêm o prompt (via JSON, sem acoplar ao formato). */
async function userEntriesWith(
	session: Awaited<ReturnType<typeof openFake>>["session"],
	text: string,
) {
	const view = await session.conversation.context(context);
	return view.entries.filter(
		(entry) =>
			entry.kind === "pi.user" && JSON.stringify(entry.model).includes(text),
	);
}

describe("handoff de sessão entre frontends", () => {
	it("inv1+2: submit admite sem exigir pi.user imediato; watch entrega a resposta", async () => {
		await withDir(async (dir, dbPath) => {
			const { session, faux } = await openFake(dir, dbPath);
			faux.setResponses([
				fauxAssistantMessage("primeira"),
				fauxAssistantMessage("segunda"),
			]);

			// Admissão: resolve sem esperar a resposta. Nada aqui exige
			// `pi.user` no transcript — a segunda submissão pode ficar `queued`.
			const s1 = await submit(session, "passo um", context);
			const s2 = await submit(session, "passo dois", context);
			expect(s1.id).toBeDefined();
			expect(s2.id).toBeDefined();

			const o1 = await watch(session, s1, context);
			expect(o1).toMatchObject({
				submissionId: s1.id,
				status: "done",
				answer: "primeira",
			});
			const o2 = await watch(session, s2, context);
			expect(o2).toMatchObject({
				submissionId: s2.id,
				status: "done",
				answer: "segunda",
			});
			await closeAgent(session, context);
		});
	});

	it("inv3: prompt idêntico pendente reaproveita a submissão sem id explícito", async () => {
		await withDir(async (dir, dbPath) => {
			const { session, faux } = await openFake(dir, dbPath);
			faux.setResponses([fauxAssistantMessage("ok")]);

			const a = await submit(session, "duplicado", context);
			const b = await submit(session, "duplicado", context);
			expect(b.id).toBe(a.id);

			const outcome = await watch(session, a, context);
			expect(outcome).toMatchObject({ status: "done", answer: "ok" });
			await closeAgent(session, context);
		});
	});

	it("inv4: requestIds diferentes não colapsam; transcript tem duas entradas pi.user", async () => {
		await withDir(async (dir, dbPath) => {
			const { session, faux } = await openFake(dir, dbPath);
			faux.setResponses([
				fauxAssistantMessage("da web"),
				fauxAssistantMessage("do cli"),
			]);

			const daWeb = await submit(session, "oi", context, "web-1");
			const doCli = await submit(session, "oi", context, "cli-1");
			expect(doCli.id).not.toBe(daWeb.id);

			expect(await watch(session, daWeb, context)).toMatchObject({
				status: "done",
			});
			expect(await watch(session, doCli, context)).toMatchObject({
				status: "done",
			});

			// Sem exigir adjacência: só a contagem exata com esse texto.
			expect(await userEntriesWith(session, "oi")).toHaveLength(2);
			await closeAgent(session, context);
		});
	});

	it("inv5: mesmo requestId reaproveita a submissão depois de reabrir o banco", async () => {
		await withDir(async (dir, dbPath) => {
			const first = await openFake(dir, dbPath);
			const pendente = await submit(first.session, "oi", context, "handoff-1");
			await closeAgent(first.session, context);

			const second = await openFake(dir, dbPath);
			second.faux.setResponses([fauxAssistantMessage("retomada")]);
			const retomada = await submit(second.session, "oi", context, "handoff-1");
			expect(retomada.id).toBe(pendente.id);

			expect(await watch(second.session, retomada, context)).toMatchObject({
				status: "done",
				answer: "retomada",
			});
			await closeAgent(second.session, context);
		});
	});

	it("inv6: watch limpa a intenção; novo submit implícito cria outra submissão", async () => {
		await withDir(async (dir, dbPath) => {
			const { session, faux } = await openFake(dir, dbPath);
			faux.setResponses([
				fauxAssistantMessage("um"),
				fauxAssistantMessage("dois"),
			]);

			const primeira = await submit(session, "repete", context);
			expect(await watch(session, primeira, context)).toMatchObject({
				status: "done",
			});
			const segunda = await submit(session, "repete", context);
			expect(segunda.id).not.toBe(primeira.id);
			expect(await watch(session, segunda, context)).toMatchObject({
				status: "done",
			});
			await closeAgent(session, context);
		});
	});

	it("inv7: segundo openAgent no mesmo dbPath falha até closeAgent liberar", async () => {
		await withDir(async (dir, dbPath) => {
			const { session } = await openFake(dir, dbPath);
			await expect(openFake(dir, dbPath)).rejects.toThrow();
			await closeAgent(session, context);

			const deNovo = await openFake(dir, dbPath);
			await closeAgent(deNovo.session, context);
		});
	});

	it("inv8: stopReason error vira unanswered com reason e sem answer", async () => {
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
			expect(outcome.answer).toBeUndefined();
			await closeAgent(session, context);
		});
	});

	it("inv9: watch com handle do harness fechado rejeita; handoff é por requestId", async () => {
		await withDir(async (dir, dbPath) => {
			const first = await openFake(dir, dbPath);
			first.faux.setResponses([fauxAssistantMessage("travada")]);
			const stale = await submit(first.session, "oi", context, "stale-1");
			await closeAgent(first.session, context);

			await expect(watch(first.session, stale, context)).rejects.toThrow();

			// O outro frontend retoma pelo requestId, nunca pelo handle.
			const second = await openFake(dir, dbPath);
			second.faux.setResponses([fauxAssistantMessage("retomada")]);
			const retomada = await submit(second.session, "oi", context, "stale-1");
			expect(retomada.id).toBe(stale.id);
			expect(await watch(second.session, retomada, context)).toMatchObject({
				status: "done",
			});
			await closeAgent(second.session, context);
		});
	});

	it("inv10: ask equivale a submit seguido de watch", async () => {
		await withDir(async (dir, dbPath) => {
			const { session, faux } = await openFake(dir, dbPath);
			faux.setResponses([
				fauxAssistantMessage("mesma"),
				fauxAssistantMessage("mesma"),
			]);

			const viaAsk = await ask(session, "pergunta", context);
			const sub = await submit(session, "outra", context);
			const viaWatch = await watch(session, sub, context);

			expect(viaAsk).toMatchObject({ status: "done", answer: "mesma" });
			expect(viaWatch).toMatchObject({
				submissionId: sub.id,
				status: "done",
				answer: "mesma",
			});
			expect(viaAsk.submissionId).toBeDefined();
			await closeAgent(session, context);
		});
	});

	it("inv11: reabrir o mesmo banco com outro workspace falha com cwd igual", async () => {
		await withDir(async (dir, dbPath) => {
			const primeiro = await openFake(dir, dbPath, "ws-a");
			await closeAgent(primeiro.session, context);

			await expect(openFake(dir, dbPath, "ws-b")).rejects.toThrow(/workspace/);

			const deNovo = await openFake(dir, dbPath, "ws-a");
			await closeAgent(deNovo.session, context);
		});
	});
});
