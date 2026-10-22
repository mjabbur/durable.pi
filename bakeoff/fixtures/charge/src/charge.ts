import type { Context } from "@earendil-works/chord";
import type { ConversationId, Session } from "@earendil-works/pi-durable";

export interface ChargeProvider {
	/**
	 * Idempotente por chave: repetir a mesma chave não cobra de novo e devolve
	 * o mesmo resultado. A chave é gerada pela implementação, não pelo chamador.
	 */
	charge(
		key: string,
		amountCents: number,
	): Promise<{ key: string; amountCents: number }>;
}

export interface ChargeResult {
	status: "charged";
	key: string;
	amountCents: number;
}

export async function chargeOnce(
	_session: Session,
	_conversationId: ConversationId,
	_requestId: string,
	_amountCents: number,
	_provider: ChargeProvider,
	_context: Context,
): Promise<ChargeResult> {
	throw new Error("not implemented");
}

export async function readCharge(
	_session: Session,
	_conversationId: ConversationId,
	_requestId: string,
	_context: Context,
): Promise<ChargeResult | undefined> {
	throw new Error("not implemented");
}
