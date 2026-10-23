import { describe, expect, it } from "vitest";
import { sanitizeForTerminal } from "../../src/tui/text.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("sanitizeForTerminal", () => {
	it("(1) mantem texto comum com newline e tab", () => {
		expect(sanitizeForTerminal("ola\nmundo\t!")).toBe("ola\nmundo\t!");
	});

	it("(2) remove sequencias CSI", () => {
		expect(sanitizeForTerminal(`${ESC}[2J`)).toBe("");
		expect(sanitizeForTerminal(`${ESC}[31mvermelho${ESC}[0m`)).toBe("vermelho");
	});

	it("(3) remove sequencias OSC terminadas em BEL e em ST", () => {
		expect(sanitizeForTerminal(`${ESC}]0;titulo${BEL}`)).toBe("");
		expect(sanitizeForTerminal(`${ESC}]0;titulo${ESC}\\`)).toBe("");
		expect(sanitizeForTerminal(`antes${ESC}]0;xyz${BEL}depois`)).toBe("antesdepois");
	});

	it("(4) remove controles C0 exceto newline e tab, incluindo CR", () => {
		const c0 = String.fromCharCode(1) + String.fromCharCode(2);
		expect(sanitizeForTerminal(`a${c0}b`)).toBe("ab");
		expect(sanitizeForTerminal("a\rb")).toBe("ab");
		expect(sanitizeForTerminal("a\nb\tc")).toBe("a\nb\tc");
		expect(sanitizeForTerminal("")).toBe("");
	});

	it("(5) remove DEL", () => {
		const del = String.fromCharCode(127);
		expect(sanitizeForTerminal(`a${del}b`)).toBe("ab");
	});

	it("(6) remove controles C1 sem deixar sequencia executavel", () => {
		const nel = String.fromCharCode(133);
		const apc = String.fromCharCode(159);
		expect(sanitizeForTerminal(`a${nel}b${apc}c`)).toBe("abc");
		const csi1 = String.fromCharCode(155);
		const resto = sanitizeForTerminal(`${csi1}31m`);
		expect(resto).toBe("31m");
		expect(resto).not.toContain(ESC);
		for (const ch of resto) {
			expect(ch.charCodeAt(0)).toBeLessThan(128);
		}
	});

	it("(7) nao come texto adjacente a sequencia", () => {
		expect(sanitizeForTerminal(`a${ESC}[2Jb`)).toBe("ab");
	});

	it("(8) e idempotente", () => {
		const del = String.fromCharCode(127);
		const nel = String.fromCharCode(133);
		const entrada = `a${ESC}[31mVermelho${ESC}]0;t${BEL}\r${del}${nel}\n\tb`;
		const uma = sanitizeForTerminal(entrada);
		expect(sanitizeForTerminal(uma)).toBe(uma);
	});
});
