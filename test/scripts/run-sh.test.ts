import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/run.sh", import.meta.url));

async function fakeBin(dir: string, name: string): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, "#!/bin/sh\nexit 0\n");
	await chmod(path, 0o755);
	return path;
}

async function writeConfig(path: string, lines: readonly string[]) {
	await writeFile(path, `${lines.join("\n")}\n`);
}

async function withDir(run: (dir: string) => void | Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "durable-run-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

interface Info {
	status: number | null;
	runtime: string;
	bin: string;
	stderr: string;
}

/** Roda só a detecção de runtime: `--runtime-info` sai antes de qualquer container. */
function runtimeInfo(dir: string, env: Record<string, string>): Info {
	const result = spawnSync("/bin/bash", [SCRIPT, "--runtime-info"], {
		encoding: "utf8",
		env: {
			PATH: dir,
			HOME: join(dir, "home"),
			// Sem o wslc padrão do Windows: o teste controla o que existe.
			DURABLE_PI_WSLC_DEFAULT: join(dir, "sem-wslc"),
			...env,
		},
	});
	const fields = new Map<string, string>();
	for (const line of (result.stdout ?? "").split("\n")) {
		const [key, ...rest] = line.split("=");
		if (key !== undefined && key !== "") fields.set(key, rest.join("="));
	}
	return {
		status: result.status,
		runtime: fields.get("runtime") ?? "",
		bin: fields.get("bin") ?? "",
		stderr: result.stderr ?? String(result.error ?? ""),
	};
}

describe("scripts/run.sh", () => {
	it("prefere podman, depois wslc, depois docker", async () => {
		await withDir(async (dir) => {
			await fakeBin(dir, "docker");
			const podman = await fakeBin(dir, "podman");

			const info = runtimeInfo(dir, {});

			expect(info.runtime).toBe("podman");
			expect(info.bin).toBe(podman);
		});
	});

	it("cai para docker quando podman não existe", async () => {
		await withDir(async (dir) => {
			const docker = await fakeBin(dir, "docker");

			const info = runtimeInfo(dir, {});

			expect(info.runtime).toBe("docker");
			expect(info.bin).toBe(docker);
		});
	});

	it("usa o caminho do arquivo de config quando o binário não está no PATH", async () => {
		await withDir(async (dir) => {
			const tools = join(dir, "tools");
			await mkdir(tools);
			const docker = await fakeBin(tools, "docker");
			const config = join(dir, "container.conf");
			await writeConfig(config, [`DURABLE_PI_DOCKER=${docker}`]);

			const info = runtimeInfo(dir, { DURABLE_PI_CONFIG: config });

			expect(info.runtime).toBe("docker");
			expect(info.bin).toBe(docker);
		});
	});

	it("deixa a variável de ambiente vencer o arquivo de config", async () => {
		await withDir(async (dir) => {
			const tools = join(dir, "tools");
			await mkdir(tools);
			const doConfig = await fakeBin(tools, "podman-config");
			const doEnv = await fakeBin(tools, "podman-env");
			const config = join(dir, "container.conf");
			await writeConfig(config, [`DURABLE_PI_PODMAN=${doConfig}`]);

			const info = runtimeInfo(dir, {
				DURABLE_PI_CONFIG: config,
				DURABLE_PI_PODMAN: doEnv,
			});

			expect(info.runtime).toBe("podman");
			expect(info.bin).toBe(doEnv);
		});
	});

	it("obedece DURABLE_PI_RUNTIME mesmo com outro runtime disponível", async () => {
		await withDir(async (dir) => {
			const podman = await fakeBin(dir, "podman");
			const docker = await fakeBin(dir, "docker");

			const info = runtimeInfo(dir, { DURABLE_PI_RUNTIME: "docker" });

			expect(info.runtime).toBe("docker");
			expect(info.bin).toBe(docker);
			expect(podman).not.toBe(docker);
		});
	});

	it("falha com mensagem quando não há runtime", async () => {
		await withDir((dir) => {
			const info = runtimeInfo(dir, {});

			expect(info.status).toBe(1);
			expect(info.stderr).toContain("nenhum runtime");
		});
	});
});
