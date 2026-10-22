import { defineDoc } from "@earendil-works/pi-durable";

/**
 * Controle de submissão pendente. A intenção (requestId + prompt) é gravada
 * antes de submeter; se o processo morrer entre admitir e receber a resposta,
 * a próxima execução reaproveita o requestId e o pi-durable devolve a submissão
 * existente em vez de admitir um segundo input.
 */
export const Control = defineDoc<{
	pending: { requestId: string; prompt: string } | null;
}>({
	kind: "app.control",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ pending: null }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});
