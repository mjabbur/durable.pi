// Processo filho do teste de crash. Não é importado pelo vitest: roda em um
// processo Node separado para que SIGKILL seja real.
//
// uso: node effect-child.mjs <crash|resume> <db> <effects.log>
//   CRASH_AT=before|after   ponto do kill no modo crash
//   TASK=query|keyed        estratégia de reconciliação
import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const [mode, dbPath, effectLog] = process.argv.slice(2);
if (!mode || !dbPath || !effectLog) {
	throw new Error("uso: effect-child.mjs <crash|resume> <db> <effects.log>");
}

const crashAt = mode === "crash" ? (process.env.CRASH_AT ?? "") : "";
const keyed = process.env.TASK === "keyed";

function chargedKeys() {
	if (!existsSync(effectLog)) return [];
	return readFileSync(effectLog, "utf8").split("\n").filter(Boolean);
}

/** Provedor sem idempotência: cada chamada cobra de novo. */
function charge(key) {
	appendFileSync(effectLog, `${key}\n`);
}

/** Provedor idempotente por chave: repetir a mesma chave não cobra de novo. */
function chargeWithKey(key) {
	if (!chargedKeys().includes(key)) charge(key);
}

function makeCharge(name, applyCharge) {
	return defineTask({
		name,
		version: 1,
		initial: (input) => ({ phase: "charge", input }),
		phases: {
			charge: async (task, runtime, context) => {
				const { key } = task.state.checkpoint.input;

				if (crashAt === "before") process.kill(process.pid, "SIGKILL");

				applyCharge(key);

				if (crashAt === "after") process.kill(process.pid, "SIGKILL");

				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "completed", result: { key } },
					}),
					context,
				);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(
				() => ({
					status: "terminal",
					outcome: { status: "failed", error: { message: "aborted" } },
				}),
				context,
			);
		},
	});
}

// Reconciliação do cliente: consulta o provedor pela chave antes de repetir.
const QueryCharge = makeCharge("test.charge-query", (key) => {
	if (!chargedKeys().includes(key)) charge(key);
});

// Reconciliação do provedor: a mesma chave não cobra de novo.
const KeyedCharge = makeCharge("test.charge-keyed", chargeWithKey);

const task = keyed ? KeyedCharge : QueryCharge;

const registry = createRegistry();
registry.install(defineExtension({ name: "test", tasks: [QueryCharge, KeyedCharge] }));

const harness = await Harness.open(
	await openNodeSqliteStorage(dbPath),
	{ models: createModels(), registry },
	BACKGROUND_CONTEXT,
);

const root = await harness.root(BACKGROUND_CONTEXT, {
	agent: { model: { provider: "test", modelId: "test" } },
});

const idFile = `${dbPath}.task-id`;
let taskId;
if (mode === "crash") {
	taskId = await root.commit(
		(tx) =>
			tx.createTask(
				task,
				{ key: "charge-1" },
				{ ownership: { kind: "conversation" }, conversationId: root.id },
			),
		BACKGROUND_CONTEXT,
	);
	appendFileSync(idFile, String(taskId));
} else {
	taskId = Number(readFileSync(idFile, "utf8"));
}

await harness.waitForIdle(BACKGROUND_CONTEXT);

const record = await harness.getTask(taskId, BACKGROUND_CONTEXT);
console.log(
	JSON.stringify({
		id: taskId,
		status: record?.state.status,
		outcome: record?.state.outcome?.status,
	}),
);

await harness.close(BACKGROUND_CONTEXT);
