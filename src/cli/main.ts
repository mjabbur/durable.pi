import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

import { agentConfigPath, readAgentConfig } from "../agent/config.js";
import { InvalidModelRefError, parseModelRef } from "../agent/models.js";
import { ask, closeAgent, openAgent, type AgentSession } from "../agent/harness.js";
import {
	ensureSessionDir,
	latestSession,
	listSessions,
	newSessionId,
	sessionPath,
} from "../agent/sessions.js";
import {
	parseArgs,
	USAGE,
	UsageError,
	type SessionOptions,
} from "./args.js";
import {
	runTui,
	type SessionSwitcher,
	type SwitchedSession,
} from "../tui/app.js";

/**
 * Injeção para teste. O catálogo de modelos é a única dependência externa do
 * `main()` que o teste não consegue montar por argumento: sem ela, o caminho
 * real do CLI (resolver sessão, abrir o banco, admitir o input) só roda contra
 * provedores de verdade.
 */
export type MainDeps = {
	readonly models?: Models;
};

/** Ponto de entrada do CLI. Devolve o código de saída em vez de chamar `process.exit`. */
export async function main(
	argv: readonly string[],
	deps: MainDeps = {},
): Promise<number> {
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

	// A TUI é dona do terminal: sem TTY não há como desenhar nem ler o editor.
	if (
		options.mode === "interactive" &&
		(!process.stdin.isTTY || !process.stdout.isTTY)
	) {
		return usageFailure(
			new UsageError(
				"o modo interativo exige um terminal (TTY); use -p \"...\" para modo impresso",
			),
		);
	}

	const context = BACKGROUND_CONTEXT;
	let dir = options.sessionDir;
	let ephemeral = false;
	let session: AgentSession | undefined;
	let sessionId: string | undefined;
	let code = 1;

	try {
		if (options.noSession) {
			dir = await mkdtemp(join(tmpdir(), "durable-pi-"));
			ephemeral = true;
		} else {
			await ensureSessionDir(dir);
		}

		const model = parseModelOrUsage(await resolveModelText(options));
		const id = await resolveSessionId(dir, options);
		sessionId = id;

		const openSession = (nextId: string): Promise<AgentSession> =>
			openAgent(
				{
					dbPath: sessionPath(dir, nextId),
					cwd: process.cwd(),
					// Identidade do projeto no host: dentro do container todo repositório
					// monta em /workspace, então `cwd` não distingue dois projetos.
					workspace: process.env["DURABLE_PI_WORKSPACE"] ?? process.cwd(),
					model,
					...(deps.models === undefined ? {} : { models: deps.models }),
				},
				context,
			);

		/**
		 * Abre a próxima sessão antes de fechar a anterior: se a abertura falhar,
		 * a sessão atual continua utilizável. O lock é por arquivo, então os dois
		 * Harnesss não disputam o mesmo storage.
		 */
		const swapSession = async (nextId: string): Promise<SwitchedSession> => {
			const opened = await openSession(nextId);
			const previous = session;
			session = opened;
			sessionId = nextId;
			if (previous !== undefined) {
				await closeAgent(previous, context).catch((error: unknown) => {
					process.stderr.write(
						`falha ao fechar a sessão anterior: ${describe(error)}\n`,
					);
				});
			}
			return { session: opened, id: nextId };
		};

		session = await openSession(id);

		if (options.mode === "interactive") {
			// Sessão efêmera não tem diretório para listar: sem troca de sessão.
			const switcher: SessionSwitcher | undefined = ephemeral
				? undefined
				: {
						list: () => listSessions(dir),
						open: swapSession,
						create: () => swapSession(newSessionId()),
					};
			code = (
				await runTui({
					session,
					context,
					...(switcher === undefined ? {} : { sessions: switcher }),
				})
			).code;
		} else {
			const outcome = await ask(session, options.prompt, context);
			if (outcome.status === "done") {
				process.stdout.write(`${outcome.answer ?? ""}\n`);
				code = 0;
			} else {
				process.stderr.write(
					`sem resposta: ${outcome.reason ?? "unanswered"}\n`,
				);
				writeResumeHint(sessionId);
				code = 1;
			}
		}
	} catch (error) {
		if (error instanceof UsageError) return usageFailure(error);
		process.stderr.write(`${describe(error)}\n`);
		writeResumeHint(sessionId);
		code = 1;
	} finally {
		// Limpeza não pode esconder o erro principal nem trocar um sucesso por falha
		// silenciosa: reporta e rebaixa o código só se ele ainda for 0.
		if (session !== undefined) {
			try {
				await closeAgent(session, context);
				// A TUI pode ter resolvido a saída antes de o Harness anunciar a
				// falha; o código de saída não pode esconder um storage quebrado.
				const end = await session.harness.closed;
				if (end.reason === "failed" && code === 0) code = 1;
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

/**
 * Recuperação exige reabrir a mesma sessão: sem `--session`/`-c` a próxima
 * execução cria outro arquivo e não vê a intenção pendente.
 */
function writeResumeHint(sessionId: string | undefined): void {
	if (sessionId === undefined) return;
	process.stderr.write(
		`sessão: ${sessionId} — retome com durable-pi --session ${sessionId} ...\n`,
	);
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
async function resolveModelText(options: SessionOptions): Promise<string> {
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
	options: SessionOptions,
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

/** `--model` malformado é erro de uso (código 2), não falha de execução. */
function parseModelOrUsage(text: string): ModelRef {
	try {
		return parseModelRef(text);
	} catch (error) {
		if (error instanceof InvalidModelRefError) {
			throw new UsageError(error.message);
		}
		throw error;
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
