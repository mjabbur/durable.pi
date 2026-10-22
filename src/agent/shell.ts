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
 * Roda um comando no mesmo ambiente do agente (`cwd` do workspace) e grava o
 * resultado no transcript. Cancelar `context` aborta o processo filho.
 */
export async function runShell(
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

	const run: ShellRun = { command, exitCode, output, aborted };
	// O commit que grava o resultado não pode herdar o cancelamento do comando.
	await session.conversation.submit(
		{
			type: "write",
			entry: {
				kind: SHELL_ENTRY_KIND,
				data: { command, exitCode, output, aborted },
			},
		},
		BACKGROUND_CONTEXT,
	);
	return run;
}

function clip(text: string): string {
	return text.length <= MAX_SHELL_OUTPUT
		? text
		: `…${text.slice(-MAX_SHELL_OUTPUT)}`;
}
