import {
	defaultSessionDir,
	assertSessionId,
	InvalidSessionIdError,
} from "../agent/sessions.js";

export const USAGE = `durable-pi — agente de código com sessão durável

Uso:
  durable-pi -p "<prompt>" [opções]

Opções:
  -p, --print <texto>     prompt; sem modo interativo no M0
      --model <p/m>       provider/modelo; default vem do config
      --session-dir <d>   diretório das sessões
      --session <id>      abre uma sessão específica
  -c, --continue          continua a sessão mais recente
      --no-session        não grava sessão (diretório temporário)
  -h, --help              esta ajuda
`;

export type PrintOptions = {
	readonly mode: "print";
	readonly prompt: string;
	/** Só `--model`; ambiente e arquivo de config entram em `main()`. */
	readonly model?: string;
	readonly sessionDir: string;
	readonly sessionId?: string;
	readonly resume: boolean;
	readonly noSession: boolean;
};

export type CliOptions = PrintOptions | { readonly mode: "help" };

export class UsageError extends Error {}

export function parseArgs(
	argv: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): CliOptions {
	let prompt: string | undefined;
	let model: string | undefined;
	let sessionDir: string | undefined;
	let sessionId: string | undefined;
	let resume = false;
	let noSession = false;
	const words: string[] = [];
	let positionalOnly = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) continue;

		if (positionalOnly) {
			words.push(arg);
			continue;
		}

		switch (arg) {
			case "-h":
			case "--help":
				return { mode: "help" };
			case "--":
				positionalOnly = true;
				break;
			case "-p":
			case "--print":
				prompt = takeValue(argv, index, arg);
				index += 1;
				break;
			case "--model":
				model = takeValue(argv, index, arg);
				index += 1;
				break;
			case "--session-dir":
				sessionDir = takeValue(argv, index, arg);
				index += 1;
				break;
			case "--session":
				sessionId = takeValue(argv, index, arg);
				index += 1;
				break;
			case "-c":
			case "--continue":
				resume = true;
				break;
			case "--no-session":
				noSession = true;
				break;
			default:
				if (arg.startsWith("-")) {
					throw new UsageError(`opção desconhecida: ${arg}`);
				}
				words.push(arg);
		}
	}

	const text = prompt ?? words.join(" ");
	if (text.trim() === "") {
		throw new UsageError("informe um prompt com -p ou como argumento");
	}

	if (noSession && resume) {
		throw new UsageError("--continue não combina com --no-session");
	}
	if (noSession && sessionId !== undefined) {
		throw new UsageError("--session não combina com --no-session");
	}
	if (sessionId !== undefined) {
		try {
			assertSessionId(sessionId);
		} catch (error) {
			if (error instanceof InvalidSessionIdError) {
				throw new UsageError(error.message);
			}
			throw error;
		}
	}

	return {
		mode: "print",
		prompt: text,
		...(model === undefined ? {} : { model }),
		sessionDir: sessionDir ?? defaultSessionDir(env),
		...(sessionId === undefined ? {} : { sessionId }),
		resume,
		noSession,
	};
}

function takeValue(
	argv: readonly string[],
	index: number,
	flag: string,
): string {
	const value = argv[index + 1];
	// Um valor começando com "-" é quase sempre a opção seguinte sem valor:
	// `--session-dir --no-session` não pode virar diretório chamado "--no-session".
	if (value === undefined || value === "" || value.startsWith("-")) {
		throw new UsageError(`${flag} exige um valor`);
	}
	return value;
}
