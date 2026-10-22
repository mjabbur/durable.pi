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

const ctx = BACKGROUND_CONTEXT;

async function withDir(run: (dir: string, dbPath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "handoff-"));
  try {
    await run(dir, join(dir, "session.sqlite"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
    ctx,
  );
  return { session, faux };
}

describe("handoff de sessão entre frontends", () => {
  it("1: submit admite o input sem esperar a resposta", async () => {
    await withDir(async (dir, dbPath) => {
      const { session, faux } = await openFake(dir, dbPath);
      faux.setResponses([fauxAssistantMessage("ok")]);
      try {
        const submission = await submit(session, "olá, agente", ctx);
        const view = await session.conversation.context(ctx);
        expect(
          view.entries.some((entry) => entry.kind === "pi.user"),
        ).toBe(true);
        const outcome = await watch(session, submission, ctx);
        expect(outcome.status).toBe("done");
      } finally {
        await closeAgent(session, ctx);
      }
    });
  });

  it("2: watch de submissão concluída devolve answer", async () => {
    await withDir(async (dir, dbPath) => {
      const { session, faux } = await openFake(dir, dbPath);
      faux.setResponses([fauxAssistantMessage("texto final")]);
      try {
        const submission = await submit(session, "pergunta", ctx);
        const outcome = await watch(session, submission, ctx);
        expect(outcome).toMatchObject({ status: "done", answer: "texto final" });
        expect(outcome.submissionId).toBe(submission.id);
      } finally {
        await closeAgent(session, ctx);
      }
    });
  });

  it("3: sem requestId, prompt idêntico ao pendente reaproveita a submissão", async () => {
    await withDir(async (dir, dbPath) => {
      const { session, faux } = await openFake(dir, dbPath);
      faux.setResponses([fauxAssistantMessage("r")]);
      try {
        const first = await submit(session, "mesmo prompt", ctx);
        const second = await submit(session, "mesmo prompt", ctx);
        expect(second.id).toBe(first.id);
        await watch(session, first, ctx);
      } finally {
        await closeAgent(session, ctx);
      }
    });
  });

  it("4: com requestId explícito, prompts iguais geram duas entradas pi.user", async () => {
    await withDir(async (dir, dbPath) => {
      const { session, faux } = await openFake(dir, dbPath);
      faux.setResponses([
        fauxAssistantMessage("da web"),
        fauxAssistantMessage("do cli"),
      ]);
      try {
        const daWeb = await submit(session, "oi", ctx, "cliente-web-1");
        const doCli = await submit(session, "oi", ctx, "cliente-cli-1");
        expect(doCli.id).not.toBe(daWeb.id);
        await watch(session, daWeb, ctx);
        await watch(session, doCli, ctx);
        const view = await session.conversation.context(ctx);
        const users = view.entries.filter((entry) => entry.kind === "pi.user");
        expect(users).toHaveLength(2);
        expect(JSON.stringify(view)).toContain("oi");
      } finally {
        await closeAgent(session, ctx);
      }
    });
  });

  it("5: mesmo requestId sobrevive a fechar e reabrir no mesmo arquivo", async () => {
    await withDir(async (dir, dbPath) => {
      const first = await openFake(dir, dbPath);
      first.faux.setResponses([fauxAssistantMessage("uma só")]);
      const submission = await submit(first.session, "oi", ctx, "id-fixo");
      await watch(first.session, submission, ctx);
      await closeAgent(first.session, ctx);

      const second = await openFake(dir, dbPath);
      try {
        second.faux.setResponses([fauxAssistantMessage("uma só")]);
        const again = await submit(second.session, "oi", ctx, "id-fixo");
        expect(again.id).toBe(submission.id);
      } finally {
        await closeAgent(second.session, ctx);
      }
    });
  });

  it("6: watch limpa a intenção; novo submit sem id cria submissão nova", async () => {
    await withDir(async (dir, dbPath) => {
      const { session, faux } = await openFake(dir, dbPath);
      faux.setResponses([
        fauxAssistantMessage("primeira"),
        fauxAssistantMessage("segunda"),
      ]);
      try {
        const first = await submit(session, "repete", ctx);
        await watch(session, first, ctx);
        const second = await submit(session, "repete", ctx);
        expect(second.id).not.toBe(first.id);
        await watch(session, second, ctx);
      } finally {
        await closeAgent(session, ctx);
      }
    });
  });

  it("7: lock é do processo: segundo open falha até closeAgent", async () => {
    await withDir(async (dir, dbPath) => {
      const { session } = await openFake(dir, dbPath);
      try {
        await expect(openFake(dir, dbPath)).rejects.toThrow();
      } finally {
        await closeAgent(session, ctx);
      }
      const reopened = await openFake(dir, dbPath);
      await closeAgent(reopened.session, ctx);
    });
  });

  it("8: stopReason error vira unanswered com reason e sem answer", async () => {
    await withDir(async (dir, dbPath) => {
      const { session, faux } = await openFake(dir, dbPath);
      faux.setResponses([
        fauxAssistantMessage("x", {
          stopReason: "error",
          errorMessage: "provedor fora do ar",
        }),
      ]);
      try {
        const outcome = await ask(session, "oi", ctx);
        expect(outcome.status).toBe("unanswered");
        expect(outcome.reason).toBeDefined();
        expect(outcome.answer).toBeUndefined();
      } finally {
        await closeAgent(session, ctx);
      }
    });
  });

  it("9: Submission pertence ao Harness que o emitiu", async () => {
    await withDir(async (dir, dbPath) => {
      const { session, faux } = await openFake(dir, dbPath);
      faux.setResponses([fauxAssistantMessage("tchau")]);
      const submission = await submit(session, "oi", ctx);
      await closeAgent(session, ctx);
      await expect(watch(session, submission, ctx)).rejects.toThrow();
    });
  });

  it("10: ask equivale a submit seguido de watch", async () => {
    await withDir(async (dir, dbPath) => {
      const { session, faux } = await openFake(dir, dbPath);
      faux.setResponses([
        fauxAssistantMessage("via ask"),
        fauxAssistantMessage("via submit+watch"),
      ]);
      try {
        const viaAsk = await ask(session, "primeira via", ctx);
        const submission = await submit(session, "segunda via", ctx);
        const viaManual = await watch(session, submission, ctx);
        expect(viaAsk).toMatchObject({ status: "done", answer: "via ask" });
        expect(viaManual).toMatchObject({
          status: "done",
          answer: "via submit+watch",
        });
        expect(viaManual.submissionId).toBe(submission.id);
      } finally {
        await closeAgent(session, ctx);
      }
    });
  });
});
