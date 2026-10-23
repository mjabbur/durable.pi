/**
 * Remove sequências de controle de saída externa (shell, tools) antes de
 * desenhar. Não há razão para conteúdo externo mover cursor, limpar tela ou
 * sequestrar o terminal; estilo também sai, porque o transcript precisa ser
 * reproduzível no resume.
 */
const OSC = /\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ESC_CHARSET = /\u001b[()#][0-9A-Za-z]/g;
const ESC_SINGLE = /\u001b[@-_]/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g;

export function sanitizeForTerminal(text: string): string {
	return text
		.replace(OSC, "")
		.replace(CSI, "")
		.replace(ESC_CHARSET, "")
		.replace(ESC_SINGLE, "")
		.replace(CONTROL, "");
}
