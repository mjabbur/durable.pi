import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Configuração do agente. `{}` quando o arquivo não existe. */
export type AgentConfig = {
	readonly model?: string;
};

/**
 * `$DURABLE_PI_AGENT_CONFIG`, senão `$XDG_CONFIG_HOME/durable-pi/config.json`,
 * senão `~/.config/durable-pi/config.json`.
 */
export function agentConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env["DURABLE_PI_AGENT_CONFIG"];
	if (explicit !== undefined && explicit !== "") return explicit;
	const configHome = env["XDG_CONFIG_HOME"];
	const base =
		configHome !== undefined && configHome !== ""
			? configHome
			: join(homedir(), ".config");
	return join(base, "durable-pi", "config.json");
}

/**
 * Lê a configuração. Arquivo ausente é configuração vazia; JSON inválido é erro
 * com o caminho, para não virar "modelo não definido" sem explicação.
 */
export async function readAgentConfig(
	env: NodeJS.ProcessEnv = process.env,
): Promise<AgentConfig> {
	const path = agentConfigPath(env);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isErrno(error, "ENOENT")) return {};
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`config inválida em ${path}: JSON malformado`);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`config inválida em ${path}: esperado objeto`);
	}

	const model = "model" in parsed ? parsed.model : undefined;
	if (model !== undefined && typeof model !== "string") {
		throw new Error(`config inválida em ${path}: "model" deve ser string`);
	}
	return model === undefined ? {} : { model };
}

function isErrno(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}
