import { describe, expect, it } from "vitest";

import { createAgentModels } from "../../src/agent/models.js";

describe("createAgentModels", () => {
	it("registra os provedores embutidos do pi-ai", () => {
		const models = createAgentModels();
		expect(models.getProvider("opencode-go")).toBeDefined();
		expect(models.getProvider("anthropic")).toBeDefined();
		expect(models.getModels().length).toBeGreaterThan(0);
	});
});
