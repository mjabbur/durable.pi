import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agentConfigPath, readAgentConfig } from "../../src/agent/config.js";

let dir: string;
let path: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "durable-config-"));
	path = join(dir, "config.json");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("agentConfigPath", () => {
	it("prefere DURABLE_PI_AGENT_CONFIG", () => {
		expect(
			agentConfigPath({
				DURABLE_PI_AGENT_CONFIG: "/x/config.json",
				XDG_CONFIG_HOME: "/y",
			}),
		).toBe("/x/config.json");
	});

	it("usa XDG_CONFIG_HOME e depois ~/.config", () => {
		expect(agentConfigPath({ XDG_CONFIG_HOME: "/y" })).toBe(
			"/y/durable-pi/config.json",
		);
		expect(agentConfigPath({ HOME: "/h" })).toMatch(/durable-pi\/config\.json$/);
	});
});

describe("readAgentConfig", () => {
	it("arquivo ausente vira configuração vazia", async () => {
		await expect(
			readAgentConfig({ DURABLE_PI_AGENT_CONFIG: path }),
		).resolves.toEqual({});
	});

	it("lê o modelo", async () => {
		await writeFile(path, JSON.stringify({ model: "opencode-go/modelo" }));
		await expect(
			readAgentConfig({ DURABLE_PI_AGENT_CONFIG: path }),
		).resolves.toEqual({ model: "opencode-go/modelo" });
	});

	it("recusa JSON malformado e campo com tipo errado, citando o arquivo", async () => {
		await writeFile(path, "{ nao json");
		await expect(
			readAgentConfig({ DURABLE_PI_AGENT_CONFIG: path }),
		).rejects.toThrow(path);

		await writeFile(path, JSON.stringify({ model: 7 }));
		await expect(
			readAgentConfig({ DURABLE_PI_AGENT_CONFIG: path }),
		).rejects.toThrow(/"model" deve ser string/);
	});
});
