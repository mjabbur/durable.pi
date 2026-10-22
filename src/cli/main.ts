import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRef } from "@earendil-works/pi-durable";

import { ask, closeAgent, openAgent } from "../agent/harness.js";
import {
	ensureSessionDir,
	latestSession,
	newSessionId,
	sessionPath,
} from "../agent/sessions.js";
import { parseArgs, USAGE, UsageError } from "./args.js";

/** Ponto de entrada do CLI. Devolve o código de saída em vez de chamar `process.exit`. */
export async function main(argv: readonly string[]): Promise<number> {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`${error.message}\n\n${USAGE}`);
			return 2;
		}
		throw error;
	}

	if (options.mode === "help") {
		process.stdout.write(USAGE);
		return 0;
	}

	const context = BACKGROUND_CONTEXT;
	let model: ModelRef;
	try {
		model = parseModel(options.model);
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`${error.message}\n`);
			return 2;
		}
		throw error;
	}

	let dir = options.sessionDir;
	let ephemeral = false;
	if (options.noSession) {
		dir = await mkdtemp(join(tmpdir(), "durable-pi-"));
		ephemeral = true;
	} else {
		await ensureSessionDir(dir);
	}

	let id = options.sessionId;
	if (id === undefined && options.resume) {
		const latest = await latestSession(dir);
		if (latest === undefined) {
			process.stderr.write(`nenhuma sessão em ${dir} para continuar\n`);
			if (ephemeral) await rm(dir, { recursive: true, force: true });
			return 1;
		}
		id = latest.id;
	}
	id ??= newSessionId();

	try {
		const session = await openAgent(
			{ dbPath: sessionPath(dir, id), cwd: process.cwd(), model },
			context,
		);
		try {
			const outcome = await ask(session, options.prompt, context);
			if (outcome.status === "done") {
				process.stdout.write(`${outcome.answer ?? ""}\n`);
				return 0;
			}
			process.stderr.write(
				`sem resposta: ${outcome.reason ?? "unanswered"}\n`,
			);
			return 1;
		} finally {
			await closeAgent(session, context);
		}
	} catch (error) {
		process.stderr.write(`${describe(error)}\n`);
		return 1;
	} finally {
		if (ephemeral) await rm(dir, { recursive: true, force: true });
	}
}

function parseModel(text: string): ModelRef {
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
