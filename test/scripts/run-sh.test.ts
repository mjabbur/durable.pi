import { spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
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

/** Runtime falso que registra cada invocação em `<dir>/calls.log`. */
async function recordingRuntime(dir: string): Promise<string> {
	const path = join(dir, "runtime");
	await writeFile(
		path,
		`#!/bin/sh
printf '%s\\n' "$*" >> "${join(dir, "calls.log")}"
exit 0
`,
	);
	await chmod(path, 0o755);
	return path;
}

async function calls(dir: string): Promise<string[]> {
	try {
		const text = await readFile(join(dir, "calls.log"), "utf8");
		return text.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

function runScript(
	dir: string,
	env: Record<string, string>,
	args: readonly string[] = [],
) {
	return spawnSync("/bin/bash", [SCRIPT, ...args], {
		cwd: dir,
		encoding: "utf8",
		env: { PATH: dir, HOME: join(dir, "home"), ...env },
	});
}

async function writeConfig(path: string, lines: readonly string[]) {
	await writeFile(path, `${lines.join("\n")}\n`);
}

async function withDir(run: (dir: string) => void | Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "durable-run-"));
	try {
		// `id` falso: o PATH do teste é só este diretório.
		await writeFile(
			join(dir, "id"),
			"#!/bin/sh\ncase \"$1\" in -u) echo 1000 ;; -g) echo 1000 ;; *) echo 1000 ;; esac\n",
		);
		await chmod(join(dir, "id"), 0o755);
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

	it("executa o agente com mounts, usuário e env sem vazar valores", async () => {
		await withDir(async (dir) => {
			const runtime = await recordingRuntime(dir);

			const result = runScript(
				dir,
				{
					DURABLE_PI_RUNTIME: "docker",
					DURABLE_PI_DOCKER: runtime,
					DURABLE_PI_VOLUME: "vol",
					DURABLE_PI_IMAGE: "img",
					OPENROUTER_API_KEY: "segredo-nao-vaza",
				},
				["-p", "oi", "--model", "p/m"],
			);

			expect(result.status).toBe(0);
			const linhas = await calls(dir);
			const agente = linhas.at(-1) ?? "";
			expect(agente).toContain("--rm");
			expect(agente).toContain(`-v ${dir}:/workspace`);
			expect(agente).toContain("-v vol:/home/agent");
			expect(agente).toContain("-w /workspace");
			expect(agente).toContain("-e OPENROUTER_API_KEY");
			expect(agente).toContain("img -p oi --model p/m");
			expect(agente).not.toContain("segredo-nao-vaza");
		});
	});

	it("usa --userns=keep-id no podman rootless", async () => {
		await withDir(async (dir) => {
			const runtime = join(dir, "podman");
			await writeFile(
				runtime,
				`#!/bin/sh
printf '%s\\n' "$*" >> "${join(dir, "calls.log")}"
if [ "$1" = "info" ]; then echo true; fi
exit 0
`,
			);
			await chmod(runtime, 0o755);

			runScript(dir, {
				DURABLE_PI_RUNTIME: "podman",
				DURABLE_PI_PODMAN: runtime,
				DURABLE_PI_VOLUME: "vol",
				DURABLE_PI_IMAGE: "img",
			});

			const agente = (await calls(dir)).at(-1) ?? "";
			expect(agente).toContain("--userns=keep-id");
		});
	});

	it("recusa rodar como root sem autorização explícita", async () => {
		await withDir(async (dir) => {
			const runtime = await recordingRuntime(dir);
			// `id` falso: o script passa a se achar root.
			await writeFile(join(dir, "id"), "#!/bin/sh\necho 0\n");
			await chmod(join(dir, "id"), 0o755);

			const result = runScript(dir, {
				DURABLE_PI_RUNTIME: "docker",
				DURABLE_PI_DOCKER: runtime,
				DURABLE_PI_VOLUME: "vol",
				DURABLE_PI_IMAGE: "img",
			});

			expect(result.status).toBe(1);
			expect(result.stderr).toContain("como root");
			expect(await calls(dir)).toEqual([]);
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
