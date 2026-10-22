import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { closeAgent, openAgent, type AgentSession } from "../../src/agent/harness.js";
import { runShell, SHELL_ENTRY_KIND } from "../../src/agent/shell.js";

const context = BACKGROUND_CONTEXT;

async function withSession(
	run: (session: AgentSession, dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "durable-shell-"));
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
	try {
		await run(session, dir);
	} finally {
		await closeAgent(session, context);
		await rm(dir, { recursive: true, force: true });
	}
}

describe("!comando", () => {
	it("roda no cwd do agente e grava o resultado como entrada de exibição", async () => {
		await withSession(async (session) => {
			const run = await runShell(session, "echo olá && pwd", context);

			expect(run.exitCode).toBe(0);
			expect(run.aborted).toBe(false);
			expect(run.output).toContain("olá");

			const view = await session.conversation.context(context);
			const entry = view.entries.find(
				(candidate) => candidate.kind === SHELL_ENTRY_KIND,
			);
			expect(entry?.data).toMatchObject({
				command: "echo olá && pwd",
				exitCode: 0,
			});
			// O comando não é mensagem: não entra no contexto do modelo.
			const falado = JSON.stringify(view.messages);
			expect(falado).not.toContain("olá");
		});
	});

	it("preserva o código de saída e a saída de erro", async () => {
		await withSession(async (session) => {
			const run = await runShell(session, "echo falhou >&2; exit 3", context);

			expect(run.exitCode).toBe(3);
			expect(run.output).toContain("falhou");
		});
	});

	it("cancelar o contexto aborta o processo e registra o resultado", async () => {
		await withSession(async (session) => {
			const cancelable = withCancel(context);
			const started = Date.now();
			const pending = runShell(session, "sleep 5", cancelable.context);
			setTimeout(() => cancelable.cancel(), 100);

			const run = await pending;

			expect(run.aborted).toBe(true);
			expect(run.exitCode).toBe(130);
			expect(Date.now() - started).toBeLessThan(4_000);
			const view = await session.conversation.context(context);
			expect(
				view.entries.some((entry) => entry.kind === SHELL_ENTRY_KIND),
			).toBe(true);
		});
	}, 20_000);
});
