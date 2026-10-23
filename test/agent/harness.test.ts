import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	BACKGROUND_CONTEXT,
	withCancel,
} from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { Control } from "../../src/agent/control.js";
import {
	ask,
	closeAgent,
	openAgent,
	resumePendingIntents,
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
async function openFake(
	dir: string,
	dbPath: string,
	options: { workspace?: string } = {},
) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const session = await openAgent(
		{
			dbPath,
			cwd: dir,
			...(options.workspace === undefined
				? {}
				: { workspace: options.workspace }),
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

	it("mesmo requestId com prompt diferente recusa em vez de admitir o errado", async () => {
		await withDir(async (dir, dbPath) => {
			const { session } = await openFake(dir, dbPath);

			await expect(
				submit(session, "primeiro", context, "id-repetido"),
			).resolves.toBeDefined();
			await expect(
				submit(session, "outro", context, "id-repetido"),
			).rejects.toThrow(/já pertence a outro prompt/);

			await closeAgent(session, context);
		});
	});

	it("no limite de intenções pendentes recusa o novo pedido sem descartar antigo", async () => {
		await withDir(async (dir, dbPath) => {
			const { session } = await openFake(dir, dbPath);
			await session.conversation.commit(async (tx) => {
				const control = await tx.doc(Control, session.conversation.id);
				for (let index = 0; index < 8; index += 1) {
					control.pending.push({
						requestId: `pendente-${index}`,
						prompt: `pedido ${index}`,
					});
				}
			}, context);

			await expect(submit(session, "nono", context)).rejects.toThrow(
				/8 intenções pendentes/,
			);
			const view = await session.conversation.commit(async (tx) => {
				const control = await tx.doc(Control, session.conversation.id);
				return control.pending.map((intent) => intent.requestId);
			}, context);
			expect(view).toHaveLength(8);
			expect(view[0]).toBe("pendente-0");

			await closeAgent(session, context);
		});
	});

	it("cancelar a espera do fechamento mantém o lock até a limpeza terminar", async () => {
		await withDir(async (dir, dbPath) => {
			const { session, faux } = await openFake(dir, dbPath);
			let release: () => void = () => undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let started = false;
			faux.setResponses([
				async () => {
					started = true;
					await gate;
					return fauxAssistantMessage("depois");
				},
			]);
			await submit(session, "segura a invocação", context);
			// Só fecha depois que a invocação realmente começou: é ela que o
			// fechamento precisa drenar.
			for (let attempt = 0; attempt < 200 && !started; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(started).toBe(true);

			const cancellable = withCancel(context);
			const closing = closeAgent(session, cancellable.context);
			cancellable.cancel(new Error("desisti de esperar"));
			await expect(closing).rejects.toThrow();

			// A limpeza continua e o lock ainda é dela.
			await expect(openFake(dir, dbPath)).rejects.toThrow(
				/em uso por outro processo/,
			);

			release();
			await session.harness.closed;
			// O release do lock acontece depois do fechamento; espera curta.
			for (let attempt = 0; attempt < 100; attempt += 1) {
				try {
					const reopened = await openFake(dir, dbPath);
					await closeAgent(reopened.session, context);
					return;
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			}
			throw new Error("o lock não foi liberado depois do fechamento");
		});
	});

	it("vincula a sessão ao workspace do host, não só ao cwd", async () => {
		await withDir(async (dir, dbPath) => {
			const primeiro = await openFake(dir, dbPath, { workspace: "C:/repo-a" });
			await closeAgent(primeiro.session, context);

			// Mesmo cwd (no container, /workspace), projeto diferente no host.
			await expect(
				openFake(dir, dbPath, { workspace: "C:/repo-b" }),
			).rejects.toThrow(/workspace C:\/repo-a/);

			const deNovo = await openFake(dir, dbPath, { workspace: "C:/repo-a" });
			await closeAgent(deNovo.session, context);
		});
	});

	it("preserva a intenção implícita quando outro cliente admite", async () => {
		await withDir(async (dir, dbPath) => {
			const first = await openFake(dir, dbPath);
			first.faux.setResponses([
				fauxAssistantMessage("a"),
				fauxAssistantMessage("b"),
			]);
			const a = await submit(first.session, "prompt A", context);
			const b = await submit(first.session, "prompt B", context, "cliente-web-1");
			// Crash antes de assistir qualquer desfecho: as duas ficam pendentes.
			await closeAgent(first.session, context);

			const second = await openFake(dir, dbPath);
			second.faux.setResponses([
				fauxAssistantMessage("a de novo"),
				fauxAssistantMessage("b de novo"),
			]);

			// A intenção implícita de A sobreviveu ao submit explícito de B.
			const retomada = await submit(second.session, "prompt A", context);
			expect(retomada.id).toBe(a.id);
			await watch(second.session, retomada, context);

			const bDeNovo = await submit(second.session, "prompt B", context, "cliente-web-1");
			expect(bDeNovo.id).toBe(b.id);
			await watch(second.session, bDeNovo, context);

			const view = await second.session.conversation.context(context);
			expect(
				view.entries.filter((entry) => entry.kind === "pi.user"),
			).toHaveLength(2);
			await closeAgent(second.session, context);
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

describe("resumePendingIntents", () => {
	it("reenvia intenção gravada antes da admissão e limpa a fila", async () => {
		await withDir(async (dir, dbPath) => {
			const { session, faux } = await openFake(dir, dbPath);
			faux.setResponses([fauxAssistantMessage("retomado")]);
			// Janela entre o commit da intenção e `conversation.submit()`: o crash
			// aqui deixa o pedido no doc e nenhuma submissão no harness.
			await session.conversation.commit(async (tx) => {
				const control = await tx.doc(Control, session.conversation.id);
				control.pending.push({ requestId: "rec-1", prompt: "pedido antigo" });
			}, context);

			expect(await resumePendingIntents(session, context)).toBe(1);
			// A intenção já foi admitida: um segundo reenvio não duplica input.
			expect(await resumePendingIntents(session, context)).toBe(0);

			session.harness.resume();
			await session.harness.waitForIdle(context);

			const view = await session.conversation.context(context);
			const usuarios = view.entries.filter((entry) => entry.kind === "pi.user");
			expect(usuarios).toHaveLength(1);
			expect(JSON.stringify(usuarios[0]?.model)).toContain("pedido antigo");
			expect(
				view.entries.some((entry) => entry.kind === "pi.assistant"),
			).toBe(true);
			await closeAgent(session, context);
		});
	});
});
