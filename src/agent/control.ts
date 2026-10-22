import { defineDoc } from "@earendil-works/pi-durable";

/** Intenção de submit: o `requestId` que o cliente usou e o prompt que a gerou. */
export type PendingIntent = {
	readonly requestId: string;
	readonly prompt: string;
};

/**
 * Mais de uma intenção pode estar pendente: um cliente implícito (CLI) admite
 * um prompt, um cliente explícito (web) admite outro, e nenhum dos dois pode
 * apagar a recuperação do outro. O limite evita crescer sem fim se o processo
 * morrer muitas vezes sem resposta.
 */
export const MAX_PENDING = 8;

/**
 * Controle de submissão: workspace da sessão e intenções ainda sem desfecho.
 *
 * A intenção é gravada antes de submeter. Se o processo morrer entre admitir e
 * receber a resposta, a próxima execução reaproveita o `requestId` e o
 * pi-durable devolve a submissão existente em vez de admitir um segundo input.
 */
export type ControlState = {
	/** Identidade do workspace no host; `null` até a primeira abertura. */
	workspace: string | null;
	pending: PendingIntent[];
};

export const Control = defineDoc<{
	/** Identidade do workspace no host; `null` até a primeira abertura. */
	workspace: string | null;
	pending: PendingIntent[];
}>({
	kind: "app.control",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ workspace: null, pending: [] }),
	migrate: (value, fromVersion): ControlState => {
		if (fromVersion >= 2) {
			return {
				workspace: typeof value["workspace"] === "string" ? value["workspace"] : null,
				pending: toPendingList(value["pending"]),
			};
		}
		return { workspace: null, pending: toPendingList(value["pending"]) };
	},
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

/** V1 guardava uma única intenção (objeto) ou nenhuma (`null`). */
function toPendingList(value: unknown): PendingIntent[] {
	if (Array.isArray(value)) return value.filter(isPendingIntent).map(onlyIntent);
	if (isPendingIntent(value)) return [onlyIntent(value)];
	return [];
}

/** Copia só os campos conhecidos: a doc não deve carregar lixo de versões antigas. */
function onlyIntent(intent: PendingIntent): PendingIntent {
	return { requestId: intent.requestId, prompt: intent.prompt };
}

function isPendingIntent(value: unknown): value is PendingIntent {
	return (
		typeof value === "object" &&
		value !== null &&
		"requestId" in value &&
		typeof value.requestId === "string" &&
		"prompt" in value &&
		typeof value.prompt === "string"
	);
}
