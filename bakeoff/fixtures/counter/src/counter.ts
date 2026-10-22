import type { Context } from "@earendil-works/chord";
import type { ConversationId, Session } from "@earendil-works/pi-durable";

export async function bumpOnce(
	_session: Session,
	_conversationId: ConversationId,
	_requestId: string,
	_context: Context,
): Promise<number> {
	throw new Error("not implemented");
}

export async function readCount(
	_session: Session,
	_conversationId: ConversationId,
	_context: Context,
): Promise<number> {
	throw new Error("not implemented");
}
