import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type SessionInfo = {
	readonly id: string;
	readonly path: string;
	readonly modifiedAt: number;
};

/** ID fora do padrão aceito: o CLI traduz em erro de uso. */
export class InvalidSessionIdError extends Error {
	constructor(id: string) {
		super(`id de sessão inválido: ${id} (use letras, números, ponto, hífen)`);
		this.name = "InvalidSessionIdError";
	}
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `$DURABLE_PI_SESSION_DIR`, senão `$XDG_DATA_HOME/durable-pi/sessions`, senão `~/.local/share/...`. */
export function defaultSessionDir(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env["DURABLE_PI_SESSION_DIR"];
	if (explicit !== undefined && explicit !== "") return explicit;
	const dataHome = env["XDG_DATA_HOME"];
	const base =
		dataHome !== undefined && dataHome !== ""
			? dataHome
			: join(homedir(), ".local", "share");
	return join(base, "durable-pi", "sessions");
}

export function sessionPath(dir: string, id: string): string {
	assertSessionId(id);
	return join(dir, `${id}.sqlite`);
}

/** Ordenável por nome: `20261022T120000-4f3a1c`. */
export function newSessionId(now: Date = new Date()): string {
	const stamp = now
		.toISOString()
		.replace(/\.\d+Z$/, "")
		.replace(/[-:]/g, "");
	return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export async function ensureSessionDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}

/**
 * Sessões em disco, mais recente primeiro. Só arquivo regular `.sqlite`.
 * Diretório ausente é lista vazia; qualquer outro erro sobe.
 */
export async function listSessions(dir: string): Promise<SessionInfo[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return [];
		throw error;
	}
	const sessions: SessionInfo[] = [];
	for (const name of names) {
		if (!name.endsWith(".sqlite")) continue;
		const id = name.slice(0, -".sqlite".length);
		if (!ID_PATTERN.test(id)) continue;
		const path = join(dir, name);
		const info = await stat(path).catch(() => undefined);
		if (info === undefined || !info.isFile()) continue;
		// Commits recentes podem estar só no WAL até o checkpoint: a atividade
		// da sessão é o mais novo entre banco e WAL.
		const wal = await stat(`${path}-wal`).catch(() => undefined);
		const modifiedAt = Math.max(info.mtimeMs, wal?.mtimeMs ?? 0);
		sessions.push({ id, path, modifiedAt });
	}
	return sessions.sort((left, right) => right.modifiedAt - left.modifiedAt);
}

export async function latestSession(
	dir: string,
): Promise<SessionInfo | undefined> {
	return (await listSessions(dir))[0];
}

/** Impede que `--session` escape do diretório de sessões. */
export function assertSessionId(id: string): void {
	if (!ID_PATTERN.test(id)) throw new InvalidSessionIdError(id);
}

function isErrno(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}
