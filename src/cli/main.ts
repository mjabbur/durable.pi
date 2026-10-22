import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRef } from "@earendil-works/pi-durable";

import { agentConfigPath, readAgentConfig } from "../agent/config.js";
import { ask, closeAgent, openAgent, type AgentSession } from "../agent/harness.js";
import {
	ensureSessionDir,
	latestSession,
	newSessionId,
	sessionPath,
} from "../agent/sessions.js";
import { parseArgs, USAGE, UsageError, type PrintOptions } from "./args.js";

/** Ponto de entrada do CLI. Devolve o código de saída em vez de chamar `process.exit`. */
export async function main(argv: readonly string[]): Promise<number> {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		return usageFailure(error);
	}

	if (options.mode === "help") {
		process.stdout.write(USAGE);
		return 0;
	}

	const context = BACKGROUND_CONTEXT;
	let dir = options.sessionDir;
	let ephemeral = false;
	let session: AgentSession | undefined;
	let code = 1;

	try {
		if (options.noSession) {
			dir = await mkdtemp(join(tmpdir(), "durable-pi-"));
			ephemeral = true;
		} else {
			await ensureSessionDir(dir);
		}

		const model = parseModel(await resolveModelText(options));
		const id = await resolveSessionId(dir, options);
		session = await openAgent(
			{ dbPath: sessionPath(dir, id), cwd: process.cwd(), model },
			context,
		);

		const outcome = await ask(session, options.prompt, context);
		if (outcome.status === "done") {
			process.stdout.write(`${outcome.answer ?? ""}\n`);
			code = 0;
		} else {
			process.stderr.write(`sem resposta: ${outcome.reason ?? "unanswered"}\n`);
			code = 1;
		}
	} catch (error) {
		if (error instanceof UsageError) return usageFailure(error);
		process.stderr.write(`${describe(error)}\n`);
		code = 1;
	} finally {
		// Limpeza não pode esconder o erro principal nem trocar um sucesso por falha
		// silenciosa: reporta e rebaixa o código só se ele ainda for 0.
		if (session !== undefined) {
			try {
				await closeAgent(session, context);
			} catch (error) {
				process.stderr.write(`falha ao fechar a sessão: ${describe(error)}\n`);
				if (code === 0) code = 1;
			}
		}
		if (ephemeral) {
			try {
				await rm(dir, { recursive: true, force: true });
			} catch (error) {
				process.stderr.write(`falha ao remover ${dir}: ${describe(error)}\n`);
				if (code === 0) code = 1;
			}
		}
	}

	return code;
}

function usageFailure(error: unknown): number {
	if (error instanceof UsageError) {
		process.stderr.write(`${error.message}\n\n${USAGE}`);
		return 2;
	}
	throw error;
}

/**
 * Modelo efetivo da execução: `--model`, depois `DURABLE_PI_MODEL`, depois o
 * arquivo de config. A sessão guarda o último modelo usado, mas ele nunca é
 * default — `--model` de uma execução não muda a próxima.
 */
async function resolveModelText(options: PrintOptions): Promise<string> {
	if (options.model !== undefined) return options.model;

	const fromEnv = process.env["DURABLE_PI_MODEL"];
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

	const config = await readAgentConfig();
	if (config.model !== undefined) return config.model;

	throw new UsageError(
		`defina o modelo em ${agentConfigPath()} ({"model": "provider/modelo"}) ` +
			"ou passe --model",
	);
}

async function resolveSessionId(
	dir: string,
	options: PrintOptions,
): Promise<string> {
	if (options.sessionId !== undefined) return options.sessionId;
	if (options.resume) {
		const latest = await latestSession(dir);
		if (latest === undefined) {
			throw new Error(`nenhuma sessão em ${dir} para continuar`);
		}
		return latest.id;
	}
	return newSessionId();
}

export function parseModel(text: string): ModelRef {
	const slash = text.indexOf("/");
	if (slash <= 0 || slash === text.length - 1) {
		throw new UsageError(
			`modelo inválido: ${text} (esperado provider/modelo)`,
		);
	}
	return {
		provider: text.slice(0, slash),
		modelId: text.slice(slash + 1),
	};
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
