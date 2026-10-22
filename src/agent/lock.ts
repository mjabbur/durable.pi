import { rm } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";

import { isErrno } from "./fs-errors.js";

export type StorageLock = {
	readonly path: string;
	release(): Promise<void>;
};

/**
 * Lock exclusivo por arquivo de storage.
 *
 * `pi-durable` exige um dono por banco e o SQLite não impede dois processos de
 * abrirem o mesmo arquivo. Arquivo com PID não serve: o diretório pode estar
 * montado em outro container, onde o mesmo PID existe, e existe uma janela
 * entre criar o arquivo e escrever o dono.
 *
 * A exclusão é um unix socket em `<db>.sock`: `listen()` é atômico no kernel e
 * `connect()` responde se há dono vivo. Socket órfão de processo morto recusa
 * conexão, então é descartado e reusado — sem PID, sem relógio, sem namespace.
 */
export async function acquireStorageLock(dbPath: string): Promise<StorageLock> {
	const path = `${dbPath}.sock`;

	for (let attempt = 0; attempt < 3; attempt += 1) {
		if (await isHeld(path)) {
			throw new Error(
				`sessão em uso por outro processo (${path}); feche-o antes de abrir de novo`,
			);
		}

		// Socket de dono morto: ninguém aceita conexão, pode ser removido.
		await rm(path, { force: true });
		try {
			const server = await listen(path);
			return { path, release: () => release(server, path) };
		} catch (error) {
			// Outro processo venceu a corrida entre o `rm` e o `listen`.
			if (!isErrno(error, "EADDRINUSE")) throw error;
		}
	}

	throw new Error(`não foi possível obter o lock de ${dbPath}`);
}

/** Há dono vivo? `connect()` só completa se alguém está escutando no socket. */
function isHeld(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(path);
		const finish = (held: boolean) => {
			socket.destroy();
			resolve(held);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function listen(path: string): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer((socket) => socket.destroy());
		// O socket não pode manter o processo vivo; o Harness é o dono do ciclo.
		server.unref();
		server.once("error", reject);
		server.listen(path, () => {
			server.removeListener("error", reject);
			server.on("error", () => undefined);
			resolve(server);
		});
	});
}

async function release(server: Server, path: string): Promise<void> {
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
	await rm(path, { force: true });
}
