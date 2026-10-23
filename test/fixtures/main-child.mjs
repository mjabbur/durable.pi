// Processo filho do crash test do CLI. Exercita `main()` — o caminho que
// resolve sessão, workspace e modelo — e não `openAgent()` direto. Roda em
// processo Node separado para que SIGKILL seja real e importa `dist/`, o mesmo
// artefato que a imagem executa (`npm run build` roda no `pretest`).
//
// uso: node main-child.mjs <crash|crash-admitted|crash-after-tool|resume|count> <sessionDir> <sessionId> <prompt>
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";

import { Control } from "../../dist/agent/control.js";
import {
	closeAgent,
	openAgent,
	submit,
} from "../../dist/agent/harness.js";
import { main } from "../../dist/cli/main.js";

const [mode, dir, sessionId, prompt] = process.argv.slice(2);
if (!mode || !dir || !sessionId || !prompt) {
	throw new Error(
		"uso: main-child.mjs <crash|crash-admitted|crash-after-tool|resume|count> <sessionDir> <sessionId> <prompt>",
	);
}

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const modelo = faux.getModel();
const model = { provider: modelo.provider, modelId: modelo.id };
const modelText = `${model.provider}/${model.modelId}`;

if (mode === "count") {
	// Leitura pós-execução: o `main()` já fechou o Harness, então este processo
	// pode tomar o storage e contar as entradas de usuário.
	const session = await openAgent(
		{ dbPath: join(dir, `${sessionId}.sqlite`), cwd: process.cwd(), model, models },
		BACKGROUND_CONTEXT,
	);
	const view = await session.conversation.context(BACKGROUND_CONTEXT);
	const userEntries = view.entries.filter((entry) => entry.kind === "pi.user");
	const toolResults = view.entries.filter(
		(entry) => entry.kind === "pi.tool-result",
	);
	const toolCalls = view.entries
		.filter((entry) => entry.kind === "pi.assistant")
		.flatMap((entry) => entry.model ?? [])
		.flatMap((message) =>
			message.role === "assistant"
				? message.content.filter((block) => block.type === "toolCall")
				: [],
		);
	console.log(
		JSON.stringify({
			userEntries: userEntries.length,
			toolResults: toolResults.length,
			toolCalls: toolCalls.length,
		}),
	);
	await closeAgent(session, BACKGROUND_CONTEXT);
} else if (mode === "crash-admitted") {
	// Submissão colocada e intenção já limpa: reabrir só conclui se o attach
	// ligar o scheduler com `harness.resume()`. A limpeza acontece antes do
	// kill para isolar essa janela da reconciliação de intenções.
	let release = () => undefined;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		async () => {
			await gate;
			process.kill(process.pid, "SIGKILL");
			return fauxAssistantMessage("inalcançável");
		},
	]);
	const session = await openAgent(
		{ dbPath: join(dir, `${sessionId}.sqlite`), cwd: process.cwd(), model, models },
		BACKGROUND_CONTEXT,
	);
	await submit(session, prompt, BACKGROUND_CONTEXT);
	await session.conversation.commit(async (tx) => {
		const control = await tx.doc(Control, session.conversation.id);
		control.pending = [];
	}, BACKGROUND_CONTEXT);
	release();
	await new Promise(() => undefined);
} else {
	if (mode === "crash") {
		// Morre dentro da requisição ao modelo, depois de o input ser admitido e
		// antes de existir resposta.
		faux.setResponses([
			() => {
				process.kill(process.pid, "SIGKILL");
				return fauxAssistantMessage("inalcançável");
			},
		]);
	} else if (mode === "crash-after-tool") {
		// O `write` roda e o resultado é commitado; o processo morre na geração
		// seguinte, quando o efeito externo já está no transcript.
		faux.setResponses([
			fauxAssistantMessage(
				[
					// Efeito que se duplica se rodar duas vezes: é o que o teste mede.
					fauxToolCall("bash", {
						command: "printf 'uma vez\\n' >> saida.txt",
					}),
				],
				{ stopReason: "toolUse" },
			),
			() => {
				process.kill(process.pid, "SIGKILL");
				return fauxAssistantMessage("inalcançável");
			},
		]);
	} else {
		faux.setResponses([fauxAssistantMessage("resposta final")]);
	}

	const code = await main(
		[
			"-p",
			prompt,
			"--model",
			modelText,
			"--session-dir",
			dir,
			"--session",
			sessionId,
		],
		{ models },
	);
	console.log(JSON.stringify({ code }));
}
