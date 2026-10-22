import { describe, expect, it } from "vitest";

import { Control } from "../../src/agent/control.js";

const migrate = Control.definition.migrate?.bind(Control.definition);

describe("Control.migrate", () => {
	it("converte a intenção única da v1 em lista", () => {
		const value = migrate?.(
			{ pending: { requestId: "a", prompt: "p", workspace: null } },
			1,
		);
		expect(value).toEqual({
			workspace: null,
			pending: [{ requestId: "a", prompt: "p" }],
		});
	});

	it("v1 sem intenção vira lista vazia", () => {
		expect(migrate?.({ pending: null }, 1)).toEqual({
			workspace: null,
			pending: [],
		});
	});

	it("descarta intenção malformada em vez de quebrar a abertura", () => {
		expect(migrate?.({ pending: { requestId: 7 } }, 1)).toEqual({
			workspace: null,
			pending: [],
		});
	});

	it("preserva workspace e lista da v2", () => {
		const state = {
			workspace: "C:/repo",
			pending: [{ requestId: "b", prompt: "q" }],
		};
		expect(migrate?.(state, 2)).toEqual(state);
	});
});
