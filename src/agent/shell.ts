import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

import type { AgentSession } from "./harness.js";

/**
 * Entrada de exibição do `!comando`. O comando roda fora do modelo, então o
 * resultado não entra no contexto dele: fica no transcript como `write` — o
 * pacote admite esse tipo mesmo com o agente ocupado, porque não muda o que o
 * modelo vê. É por isso que o bloco sobrevive ao resume.
 */
export const SHELL_ENTRY_KIND = "durable.shell";

/** Saída guardada por comando; o resto já passou e não volta. */
export const MAX_SHELL_OUTPUT = 20_000;

export type ShellRun = {
	readonly command: string;
	readonly exitCode: number;
	readonly output: string;
	readonly aborted: boolean;
};

/**
 * Roda um comando no mesmo ambiente do agente (`cwd` do workspace) e devolve o
 * desfecho, sem gravar. Cancelar `context` aborta o processo filho.
 *
 * Separado do commit de propósito: o fechamento da TUI precisa distinguir
 * "processo ainda não terminou" de "commit lento". A classificação do desfecho
 * fica com quem chama; aqui não há relógio.
 */
export async function executeShell(
	session: AgentSession,
	command: string,
	context: Context,
): Promise<ShellRun> {
	const agent = await session.conversation.agent(context);
	const env = new NodeExecutionEnv({ cwd: agent.cwd ?? process.cwd() });

	let output = "";
	const result = await env.exec(
		command,
		{
			onOutput: (text) => {
				output = clip(output + text);
			},
		},
		context,
	);

	let exitCode: number;
	let aborted = false;
	if (result.ok) {
		exitCode = result.value.exitCode;
	} else {
		aborted = result.error.code === "aborted";
		exitCode = aborted ? 130 : 1;
		output = clip(`${output}${output === "" ? "" : "\n"}${result.error.message}`);
	}

	return { command, exitCode, output, aborted };
}

/**
 * Grava o desfecho no transcript. O commit não herda o cancelamento do comando.
 * `requestId` é opcional e serve para que o desfecho normal e o de interrupção
 * disputem a mesma admissão: o segundo reenvio devolve a submissão existente em
 * vez de duplicar a entrada.
 */
export async function commitShell(
	session: AgentSession,
	run: ShellRun,
	requestId?: string,
): Promise<void> {
	await session.conversation.submit(
		{
			type: "write",
			...(requestId === undefined ? {} : { requestId }),
			entry: {
				kind: SHELL_ENTRY_KIND,
				data: {
					command: run.command,
					exitCode: run.exitCode,
					output: run.output,
					aborted: run.aborted,
				},
			},
		},
		BACKGROUND_CONTEXT,
	);
}

/** Roda e grava; o caminho simples de quem não precisa separar as fases. */
export async function runShell(
	session: AgentSession,
	command: string,
	context: Context,
	requestId?: string,
): Promise<ShellRun> {
	const run = await executeShell(session, command, context);
	await commitShell(session, run, requestId);
	return run;
}

/**
 * Corta mantendo o tamanho total em `MAX_SHELL_OUTPUT` unidades UTF-16 e sem
 * começar no meio de um par surrogate (o registro precisa continuar válido).
 */
function clip(text: string): string {
	return text.length <= MAX_SHELL_OUTPUT
		? text
		: `…${tail(text, MAX_SHELL_OUTPUT - 1)}`;
}

/** Cauda sem começar na segunda metade de um par surrogate. */
function tail(text: string, size: number): string {
	let start = Math.max(0, text.length - size);
	const code = text.charCodeAt(start);
	if (start > 0 && code >= 0xdc00 && code <= 0xdfff) start += 1;
	return text.slice(start);
}
