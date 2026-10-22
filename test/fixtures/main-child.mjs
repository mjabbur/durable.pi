// Processo filho do crash test do CLI. Exercita `main()` — o caminho que
// resolve sessão, workspace e modelo — e não `openAgent()` direto. Roda em
// processo Node separado para que SIGKILL seja real e importa `dist/`, o mesmo
// artefato que a imagem executa (`npm run build` roda no `pretest`).
//
// uso: node main-child.mjs <crash|resume|count> <sessionDir> <sessionId> <prompt>
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";

import { closeAgent, openAgent } from "../../dist/agent/harness.js";
import { main } from "../../dist/cli/main.js";

const [mode, dir, sessionId, prompt] = process.argv.slice(2);
if (!mode || !dir || !sessionId || !prompt) {
	throw new Error(
		"uso: main-child.mjs <crash|resume|count> <sessionDir> <sessionId> <prompt>",
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
	console.log(JSON.stringify({ userEntries: userEntries.length }));
	await closeAgent(session, BACKGROUND_CONTEXT);
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
