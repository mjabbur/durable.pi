import {
	getTerminalColorMode,
	styleText,
	type EditorTheme,
	type MarkdownTheme,
	type SelectListTheme,
	type TextStyle,
} from "@earendil-works/pi-tui";

/**
 * Temas em tons neutros: só atributos (dim, bold), sem paleta. Funcionam em
 * terminal sem cor e não competem com o realce de sintaxe do markdown.
 */
const mode = getTerminalColorMode();

function styled(style: TextStyle) {
	return (text: string): string => styleText(text, style, mode);
}

const dim = styled({ dim: true });
const bold = styled({ bold: true });
const underline = styled({ underline: true });

export const markdownTheme: MarkdownTheme = {
	heading: bold,
	link: underline,
	linkUrl: dim,
	code: dim,
	codeBlock: (text) => text,
	codeBlockBorder: dim,
	quote: (text) => text,
	quoteBorder: dim,
	hr: dim,
	listBullet: dim,
	bold,
	italic: styled({ italic: true }),
	strikethrough: styled({ strikethrough: true }),
	underline,
};

const selectList: SelectListTheme = {
	selectedPrefix: bold,
	selectedText: bold,
	description: dim,
	scrollInfo: dim,
	noMatch: dim,
};

export const editorTheme: EditorTheme = {
	borderColor: dim,
	selectList,
};

export const theme = { dim, bold, underline };
