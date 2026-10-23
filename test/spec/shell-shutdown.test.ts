import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { ProgramStatus } from "@earendil-works/pi-tui";
import type { Terminal } from "@earendil-works/pi-tui";

import {
	closeAgent,
	openAgent,
	type AgentSession,
} from "../../src/agent/harness.js";
import { runShell } from "../../src/agent/shell.js";
import { runTui, type SwitchedSession } from "../../src/tui/app.js";

const MODEL = { provider: "test", modelId: "dummy" };

class FakeTerminal implements Terminal {
	private input: ((data: string) => void) | undefined;
	output = "";

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.input = onInput;
	}

	stop(): void {
		this.input = undefined;
	}

	drainInput(): Promise<void> {
		return Promise.resolve();
	}

	write(data: string): void {
		this.output += data;
	}

	get columns(): number {
		return 80;
	}

	get rows(): number {
		return 24;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {}

	showCursor(): void {}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(_title: string): void {}

	setProgress(_active: boolean): void {}

	setProgramStatus(_status: ProgramStatus): void {}

	feed(data: string): void {
		this.input?.(data);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
	terminal: FakeTerminal,
	predicate: (output: string) => boolean,
	timeoutMs = 15000,
): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (predicate(terminal.output)) return;
		if (Date.now() - start > timeoutMs) throw new Error("timeout esperando frame");
		await delay(50);
	}
}

function sendLine(terminal: FakeTerminal, text: string): void {
	terminal.feed(text);
	terminal.feed("\r");
}

async function openTempSession(): Promise<{
	session: AgentSession;
	dir: string;
	dbPath: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "shell-shutdown-"));
	const dbPath = join(dir, "s.sqlite");
	const session = await openAgent(
		{ dbPath, cwd: dir, model: MODEL },
		BACKGROUND_CONTEXT,
	);
	return { session, dir, dbPath };
}

async function shellEntries(session: AgentSession): Promise<EntryRecord[]> {
	const page = await session.conversation.entries(
		{ order: "ascending" },
		200,
		undefined,
		BACKGROUND_CONTEXT,
	);
	return page.items.filter((entry) => entry.kind === "durable.shell");
}

function shellField(entry: EntryRecord, field: string): unknown {
	const data: unknown = entry.data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return undefined;
	}
	const value = (data as { [key: string]: unknown })[field];
	return value;
}

function firstEntry(entries: readonly EntryRecord[]): EntryRecord {
	const entry = entries[0];
	if (entry === undefined) throw new Error("sem entrada durable.shell");
	return entry;
}

async function cleanup(
	session: AgentSession | undefined,
	dir: string,
): Promise<void> {
	if (session !== undefined) {
		await closeAgent(session, BACKGROUND_CONTEXT).catch(() => undefined);
	}
	await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

describe("shell no fechamento da TUI", () => {
	it("Comportamento 1: /quit ocioso resolve code 0 sem entrada durable.shell", async () => {
		const { session, dir, dbPath } = await openTempSession();
		const terminal = new FakeTerminal();
		const exit = runTui({ session, context: BACKGROUND_CONTEXT, terminal });
		await waitFor(terminal, (output) => output.length > 0);
		sendLine(terminal, "/quit");
		const result = await exit;
		expect(result.code).toBe(0);
		await closeAgent(session, BACKGROUND_CONTEXT);
		const reopened = await openAgent(
			{ dbPath, cwd: dir, model: MODEL },
			BACKGROUND_CONTEXT,
		);
		try {
			expect(await shellEntries(reopened)).toHaveLength(0);
		} finally {
			await cleanup(reopened, dir);
		}
	});

	it("Comportamento 2: /quit com !comando cancela e grava aborted:true antes de sair", async () => {
		const { session, dir, dbPath } = await openTempSession();
		const terminal = new FakeTerminal();
		const exit = runTui({ session, context: BACKGROUND_CONTEXT, terminal });
		await waitFor(terminal, (output) => output.length > 0);
		sendLine(terminal, "!node -e \"setTimeout(()=>{},20000)\"");
		await waitFor(terminal, (output) => output.includes("shell"));
		sendLine(terminal, "/quit");
		const result = await exit;
		expect(result.code).toBe(0);
		await closeAgent(session, BACKGROUND_CONTEXT);
		const reopened = await openAgent(
			{ dbPath, cwd: dir, model: MODEL },
			BACKGROUND_CONTEXT,
		);
		try {
			const entries = await shellEntries(reopened);
			expect(entries).toHaveLength(1);
			expect(shellField(firstEntry(entries), "aborted")).toBe(true);
		} finally {
			await cleanup(reopened, dir);
		}
	});

	it("Comportamento 3: /new grava o desfecho na sessao antiga e a nova fica sem a entrada", async () => {
		const dir = await mkdtemp(join(tmpdir(), "shell-shutdown-"));
		const oldPath = join(dir, "old.sqlite");
		const newPath = join(dir, "new.sqlite");
		const old = await openAgent(
			{ dbPath: oldPath, cwd: dir, model: MODEL },
			BACKGROUND_CONTEXT,
		);
		let current: AgentSession = old;
		const terminal = new FakeTerminal();
		const exit = runTui({
			session: old,
			context: BACKGROUND_CONTEXT,
			terminal,
			sessions: {
				list: () => Promise.resolve([]),
				open: (id: string): Promise<SwitchedSession> =>
					Promise.resolve({ session: current, id }),
				create: (): Promise<SwitchedSession> =>
					openAgent(
						{ dbPath: newPath, cwd: dir, model: MODEL },
						BACKGROUND_CONTEXT,
					).then((next) => {
						current = next;
						return { session: next, id: "new" };
					}),
			},
		});
		await waitFor(terminal, (output) => output.length > 0);
		sendLine(terminal, "!node -e \"setTimeout(()=>{},20000)\"");
		await waitFor(terminal, (output) => output.includes("shell"));
		sendLine(terminal, "/new");
		await waitFor(terminal, (output) => output.includes("sessão new"));
		const fresh: AgentSession = current;
		expect(await shellEntries(fresh)).toHaveLength(0);
		sendLine(terminal, "/quit");
		const result = await exit;
		expect(result.code).toBe(0);
		await closeAgent(old, BACKGROUND_CONTEXT);
		if (fresh !== old) await closeAgent(fresh, BACKGROUND_CONTEXT);
		const reopenedOld = await openAgent(
			{ dbPath: oldPath, cwd: dir, model: MODEL },
			BACKGROUND_CONTEXT,
		);
		try {
			const entries = await shellEntries(reopenedOld);
			expect(entries).toHaveLength(1);
			expect(shellField(firstEntry(entries), "aborted")).toBe(true);
		} finally {
			await cleanup(reopenedOld, dir);
		}
	});

	it("Comportamento 4: !comando normal grava aborted:false com o exitCode real", async () => {
		const { session, dir, dbPath } = await openTempSession();
		try {
			const run = await runShell(
				session,
				"node -e \"process.exit(3)\"",
				BACKGROUND_CONTEXT,
			);
			expect(run.aborted).toBe(false);
			expect(run.exitCode).toBe(3);
		} finally {
			await closeAgent(session, BACKGROUND_CONTEXT);
		}
		const reopened = await openAgent(
			{ dbPath, cwd: dir, model: MODEL },
			BACKGROUND_CONTEXT,
		);
		try {
			const entries = await shellEntries(reopened);
			expect(entries).toHaveLength(1);
			const entry = firstEntry(entries);
			expect(shellField(entry, "aborted")).toBe(false);
			expect(shellField(entry, "exitCode")).toBe(3);
		} finally {
			await cleanup(reopened, dir);
		}
	});

	it("Comportamento 5: Ctrl+C durante !comando grava aborted:true com exitCode 130", async () => {
		const { session, dir, dbPath } = await openTempSession();
		const terminal = new FakeTerminal();
		const exit = runTui({ session, context: BACKGROUND_CONTEXT, terminal });
		await waitFor(terminal, (output) => output.length > 0);
		sendLine(terminal, "!node -e \"setTimeout(()=>{},20000)\"");
		await waitFor(terminal, (output) => output.includes("shell"));
		terminal.feed("\x03");
		await waitFor(terminal, (output) => output.includes("abortado"));
		sendLine(terminal, "/quit");
		const result = await exit;
		expect(result.code).toBe(0);
		await closeAgent(session, BACKGROUND_CONTEXT);
		const reopened = await openAgent(
			{ dbPath, cwd: dir, model: MODEL },
			BACKGROUND_CONTEXT,
		);
		try {
			const entries = await shellEntries(reopened);
			expect(entries).toHaveLength(1);
			const entry = firstEntry(entries);
			expect(shellField(entry, "aborted")).toBe(true);
			expect(shellField(entry, "exitCode")).toBe(130);
		} finally {
			await cleanup(reopened, dir);
		}
	});

	it("Comportamento 6: falha ao gravar o desfecho nao pendura o /quit", async () => {
		const { session, dir } = await openTempSession();
		const terminal = new FakeTerminal();
		const submit = session.conversation.submit.bind(session.conversation);
		session.conversation.submit = (draft, context) => {
			if (draft.type === "write") return Promise.reject(new Error("commit falhou"));
			return submit(draft, context);
		};
		const exit = runTui({ session, context: BACKGROUND_CONTEXT, terminal });
		try {
			await waitFor(terminal, (output) => output.length > 0);
			sendLine(terminal, "!node -e \"setTimeout(()=>{},20000)\"");
			await waitFor(terminal, (output) => output.includes("shell"));
			sendLine(terminal, "/quit");
			const result = await exit;
			expect(result.code).toBe(0);
		} finally {
			session.conversation.submit = submit;
			await cleanup(session, dir);
		}
	});

	it("Comportamento 7: segundo /quit apos o primeiro nao reabre janela para o processo", async () => {
		const { session, dir } = await openTempSession();
		const terminal = new FakeTerminal();
		const exit = runTui({ session, context: BACKGROUND_CONTEXT, terminal });
		await waitFor(terminal, (output) => output.length > 0);
		sendLine(terminal, "/quit");
		const result = await exit;
		expect(result.code).toBe(0);
		sendLine(terminal, "/quit");
		terminal.feed("\x03");
		await delay(200);
		const second = await Promise.race([exit, Promise.resolve({ code: -1 })]);
		expect(second.code).toBe(0);
		await cleanup(session, dir);
	});
});
