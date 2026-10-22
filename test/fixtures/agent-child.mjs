// Processo filho do crash test do agente. Não é importado pelo vitest: roda em
// processo Node separado para que SIGKILL seja real. Importa `dist/`, o mesmo
// artefato que a imagem executa; `npm run build` roda no `pretest`.
//
// uso: node agent-child.mjs <crash|resume> <db> <cwd> <prompt>
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";

import { ask, closeAgent, openAgent } from "../../dist/agent/harness.js";

const [mode, dbPath, cwd, prompt] = process.argv.slice(2);
if (!mode || !dbPath || !cwd || !prompt) {
	throw new Error("uso: agent-child.mjs <crash|resume> <db> <cwd> <prompt>");
}

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const modelo = faux.getModel();
const model = { provider: modelo.provider, modelId: modelo.id };

if (mode === "crash") {
	// Morre dentro da requisição ao modelo: o input já foi admitido e o
	// transcript já tem a entrada do usuário, mas a resposta não existe.
	faux.setResponses([
		() => {
			process.kill(process.pid, "SIGKILL");
			return fauxAssistantMessage("inalcançável");
		},
	]);
} else {
	faux.setResponses([fauxAssistantMessage("resposta final")]);
}

const session = await openAgent(
	{ dbPath, cwd, model, models },
	BACKGROUND_CONTEXT,
);
const outcome = await ask(session, prompt, BACKGROUND_CONTEXT);
const view = await session.conversation.context(BACKGROUND_CONTEXT);
const usuarios = view.entries.filter((entry) => entry.kind === "pi.user");

console.log(
	JSON.stringify({
		status: outcome.status,
		answer: outcome.answer,
		userEntries: usuarios.length,
	}),
);
await closeAgent(session, BACKGROUND_CONTEXT);
