import type { Models } from "@earendil-works/pi-ai";
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
