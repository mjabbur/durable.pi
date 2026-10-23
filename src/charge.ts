import { randomUUID } from "node:crypto";

import type { Context } from "@earendil-works/chord";
import {
	defineDoc,
	type ConversationId,
	type Session,
} from "@earendil-works/pi-durable";

export type ChargeProvider = {
	/**
	 * Idempotente por chave: repetir a mesma chave não cobra de novo e devolve
	 * o mesmo resultado.
	 */
	charge(
		key: string,
		amountCents: number,
	): Promise<{ key: string; amountCents: number }>;
};

export type ChargeResult = {
	status: "charged";
	key: string;
	amountCents: number;
};

type ChargeIntent = {
	key: string;
	amountCents: number;
};

/**
 * Intenção e resultado no mesmo documento, por conversa. A intenção é gravada
 * antes de qualquer efeito externo; é dela que a chave idempotente sai, então
 * a chave sobrevive a reinício e nunca é regerada para o mesmo requestId.
 */
const Charges = defineDoc<{
	intents: Record<string, ChargeIntent>;
	results: Record<string, ChargeResult>;
}>({
	kind: "app.charge",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ intents: {}, results: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 512,
});

export async function chargeOnce(
	session: Session,
	conversationId: ConversationId,
	requestId: string,
	amountCents: number,
	provider: ChargeProvider,
	context: Context,
): Promise<ChargeResult> {
	// Fora do commit: o callback é puro e pode rodar mais de uma vez.
	const candidate = randomUUID();
	const state = await session.commit(async (tx) => {
		const charges = await tx.doc(Charges, conversationId);
		// Cópias: valores do draft viram overlay e não podem ser lidos depois que
		// o commit assenta.
		const stored = charges.results[requestId];
		if (stored !== undefined) {
			return {
				result: {
					status: "charged" as const,
					key: stored.key,
					amountCents: stored.amountCents,
				},
				intent: undefined,
			};
		}

		const existing = charges.intents[requestId];
		if (existing !== undefined) {
			// O valor da intenção é o compromisso: comparar com o argumento depois
			// de sobrescrevê-lo sempre daria igual.
			if (existing.amountCents !== amountCents) {
				throw new Error(
					`requestId ${requestId} já tem intenção de ${existing.amountCents} centavos`,
				);
			}
			return {
				result: undefined,
				intent: { key: existing.key, amountCents: existing.amountCents },
			};
		}
		const intent: ChargeIntent = { key: candidate, amountCents };
		charges.intents[requestId] = intent;
		return { result: undefined, intent };
	}, context);

	if (state.result !== undefined) {
		if (state.result.amountCents !== amountCents) {
			throw new Error(
				`requestId ${requestId} já cobrado com ${state.result.amountCents} centavos`,
			);
		}
		return state.result;
	}

	if (state.intent === undefined) {
		throw new Error(`intenção ausente para ${requestId}`);
	}
	if (state.intent.amountCents !== amountCents) {
		throw new Error(
			`requestId ${requestId} já tem intenção de ${state.intent.amountCents} centavos`,
		);
	}

	const charged = await provider.charge(state.intent.key, amountCents);
	const result: ChargeResult = {
		status: "charged",
		key: charged.key,
		amountCents: charged.amountCents,
	};

	await session.commit(async (tx) => {
		const charges = await tx.doc(Charges, conversationId);
		charges.results[requestId] ??= result;
	}, context);

	return result;
}

export async function readCharge(
	session: Session,
	conversationId: ConversationId,
	requestId: string,
	context: Context,
): Promise<ChargeResult | undefined> {
	const charges = await session.snapshot(Charges, conversationId, context);
	return charges?.results[requestId];
}
