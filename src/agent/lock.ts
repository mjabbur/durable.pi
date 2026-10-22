import { DatabaseSync } from "node:sqlite";

export type StorageLock = {
	readonly path: string;
	release(): Promise<void>;
};

/**
 * Lock exclusivo por arquivo de storage.
 *
 * `pi-durable` exige um dono por banco. Evitar isso com arquivo/PID não é
 * confiável: existe janela entre criar e escrever, e PID não identifica dono
 * entre containers. Socket unix também não fecha: remover o socket de um dono
 * morto pode apagar o socket de um dono novo (race entre `unlink` e `listen`).
 *
 * Aqui a exclusão é uma transação `BEGIN EXCLUSIVE` num SQLite separado
 * (`<db>.lock`), mantida aberta enquanto o Harness está aberto. O lock é do
 * kernel, liberado automaticamente quando o processo morre — sem PID, sem
 * relógio, sem arquivo órfão para detectar.
 */
// API assíncrona de propósito: a chamada é síncrona, mas o contrato do lock é
// `Promise` para quem abre storage (que é assíncrono).
// eslint-disable-next-line @typescript-eslint/require-await
export async function acquireStorageLock(dbPath: string): Promise<StorageLock> {
	const path = `${dbPath}.lock`;
	const db = new DatabaseSync(path);

	try {
		// Sem espera: quem não consegue o lock precisa falhar agora, não travar.
		db.exec("PRAGMA busy_timeout = 0");
		db.exec("BEGIN EXCLUSIVE");
		// Uma escrita garante a exclusividade mesmo se o journal for WAL.
		db.exec("CREATE TABLE IF NOT EXISTS owner (id INTEGER)");
		db.exec("DELETE FROM owner");
	} catch (error) {
		db.close();
		if (isBusy(error)) {
			throw new Error(
				`sessão em uso por outro processo (${path}); feche-o antes de abrir de novo`,
			);
		}
		throw error;
	}

	return {
		path,
		// eslint-disable-next-line @typescript-eslint/require-await
		release: async () => {
			try {
				db.exec("ROLLBACK");
			} finally {
				db.close();
			}
		},
	};
}

/** SQLite sinaliza concorrência com `SQLITE_BUSY` (5). */
function isBusy(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"errcode" in error &&
		error.errcode === 5
	);
}
