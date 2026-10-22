// Processo filho do teste de crash de `chargeOnce`. Não é importado pelo
// vitest: roda em processo Node separado para que SIGKILL seja real.
//
// uso: node charge-child.mjs <crash|resume> <db> <effects.log> [requestId]
//   CRASH_AT=before|after   ponto do kill, dentro do provedor de cobrança
//
// O provedor é idempotente por chave: a mesma chave não cobra de novo. O log de
// efeitos registra uma linha por cobrança efetiva.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { chargeOnce, readCharge } from "../../src/charge.ts";

const [mode, dbPath, effectLog, requestId = "req-1"] = process.argv.slice(2);
if (!mode || !dbPath || !effectLog) {
	throw new Error("uso: charge-child.mjs <crash|resume> <db> <effects.log> [requestId]");
}

const crashAt = mode === "crash" ? (process.env.CRASH_AT ?? "") : "";

function chargedKeys() {
	if (!existsSync(effectLog)) return [];
	return readFileSync(effectLog, "utf8").split("\n").filter(Boolean);
}

const provider = {
	async charge(key, amountCents) {
		if (crashAt === "before") process.kill(process.pid, "SIGKILL");
		if (!chargedKeys().includes(key)) appendFileSync(effectLog, `${key}\n`);
		if (crashAt === "after") process.kill(process.pid, "SIGKILL");
		return { key, amountCents };
	},
};

const storage = await openNodeSqliteStorage(dbPath);
const session = createSession(storage);
const conversationFile = `${dbPath}.conversation`;

let conversationId;
if (mode === "crash") {
	const conversation = await session.commit(
		(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
		BACKGROUND_CONTEXT,
	);
	conversationId = conversation.id;
	writeFileSync(conversationFile, String(conversationId));
} else {
	conversationId = Number(readFileSync(conversationFile, "utf8"));
}

const result = await chargeOnce(
	session,
	conversationId,
	requestId,
	500,
	provider,
	BACKGROUND_CONTEXT,
);
const stored = await readCharge(session, conversationId, requestId, BACKGROUND_CONTEXT);

console.log(JSON.stringify({ result, stored }));
await storage.close(BACKGROUND_CONTEXT);
