import { open, readFile, rm } from "node:fs/promises";

import { isErrno } from "./fs-errors.js";

export type StorageLock = {
	readonly path: string;
	release(): Promise<void>;
};

/**
 * Lock exclusivo por arquivo de storage: `pi-durable` exige um dono por banco, e
 * o SQLite sozinho não impede dois processos de abrirem o mesmo arquivo.
 *
 * `O_EXCL` cria o `.lock` de forma atômica. Se ele já existe, o PID dentro
 * decide: processo vivo recusa a abertura, processo morto (ou arquivo vazio,
 * de crash entre criar e escrever) é lock órfão e pode ser tomado.
 */
export async function acquireStorageLock(dbPath: string): Promise<StorageLock> {
	const path = `${dbPath}.lock`;

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await open(path, "wx");
			try {
				await handle.writeFile(`${process.pid}\n`, "utf8");
			} finally {
				await handle.close();
			}
			return {
				path,
				release: async () => {
					await rm(path, { force: true });
				},
			};
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;

			const owner = await readOwner(path);
			if (owner !== undefined && isAlive(owner)) {
				throw new Error(
					`sessão em uso pelo processo ${owner} (${path}); feche-o antes de abrir de novo`,
				);
			}
			await rm(path, { force: true });
		}
	}

	throw new Error(`não foi possível obter o lock de ${dbPath}`);
}

async function readOwner(path: string): Promise<number | undefined> {
	try {
		const text = await readFile(path, "utf8");
		const pid = Number.parseInt(text.trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
