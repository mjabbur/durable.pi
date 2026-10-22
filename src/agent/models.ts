import type { ModelRef } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/**
 * Catálogo de modelos do agente: todos os provedores embutidos do pi-ai, cada
 * um lendo sua credencial do ambiente (`OPENCODE_API_KEY`, `ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, ...).
 *
 * `createModels()` sozinho vem vazio: sem registrar provedor, qualquer
 * `--model` falha com `no_model`. Quem quiser um catálogo próprio passa
 * `AgentOptions.models`.
 */
export function createAgentModels(): Models {
	return builtinModels();
}

/** Níveis de raciocínio aceitos pelo `pi-ai`; `satisfies` falha se a lista divergir. */
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ModelThinkingLevel[];

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

export class InvalidModelRefError extends Error {
	constructor(text: string) {
		super(`modelo inválido: ${text} (esperado provider/modelo)`);
		this.name = "InvalidModelRefError";
	}
}

/** `provider/modelo`: o primeiro `/` separa, o resto pertence ao id do modelo. */
export function parseModelRef(text: string): ModelRef {
	const slash = text.indexOf("/");
	if (slash <= 0 || slash === text.length - 1) {
		throw new InvalidModelRefError(text);
	}
	return {
		provider: text.slice(0, slash),
		modelId: text.slice(slash + 1),
	};
}
