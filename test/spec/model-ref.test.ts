import { describe, expect, it } from "vitest";
import { InvalidModelRefError, parseModelRef } from "../../src/agent/models.js";

describe("parseModelRef", () => {
	it("Comportamento 1: 'provider/modelo' devolve provider/modelId", () => {
		expect(parseModelRef("provider/modelo")).toEqual({
			provider: "provider",
			modelId: "modelo",
		});
	});

	it("Comportamento 2: remove espaços nas pontas de cada parte", () => {
		expect(parseModelRef(" p/m ")).toEqual({ provider: "p", modelId: "m" });
	});

	it("Comportamento 3: parte só com espaços ou vazia rejeita", () => {
		for (const text of [" /x", "p/ ", " / ", "/"]) {
			expect(() => parseModelRef(text)).toThrow(InvalidModelRefError);
		}
	});

	it("Comportamento 4: sem '/' rejeita com InvalidModelRefError", () => {
		expect(() => parseModelRef("provider")).toThrow(InvalidModelRefError);
	});

	it("Comportamento 5: '/' no começo ou no fim rejeita", () => {
		expect(() => parseModelRef("/x")).toThrow(InvalidModelRefError);
		expect(() => parseModelRef("p/")).toThrow(InvalidModelRefError);
	});

	it("Comportamento 6: o primeiro '/' separa, o resto é o id", () => {
		expect(parseModelRef("a/b/c")).toEqual({ provider: "a", modelId: "b/c" });
	});

	it("Comportamento 7: não valida catálogo, qualquer par não vazio é aceito", () => {
		expect(parseModelRef("desconhecido/inexistente")).toEqual({
			provider: "desconhecido",
			modelId: "inexistente",
		});
	});

	it("Falhas visíveis: mensagem inclui o texto recebido", () => {
		try {
			parseModelRef("sem-barra");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidModelRefError);
			expect((error as Error).message).toContain("sem-barra");
		}
	});
});
