/**
 * pimessage bridge — iMessage DB polling + AppleScript sending
 *
 * Reads ~/Library/Messages/chat.db for new messages and sends
 * responses back via osascript. This is the core bidirectional bridge.
 */

import Database from "better-sqlite3";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { DB_PATH, type PimessageConfig, type PimessageState, loadState, saveState } from "./config.js";

export interface IncomingMessage {
	rowid: number;
	text: string;
	handle: string;
	isFromMe: boolean;
	timestamp: string;
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/**
 * Open the Messages database (read-only).
 * Throws a clear error if Full Disk Access is missing.
 */
export function openMessagesDb(): Database.Database {
	try {
		return new Database(DB_PATH, { readonly: true, fileMustExist: true });
	} catch (e: any) {
		if (e.message?.includes("authorization denied") || e.message?.includes("unable to open")) {
			throw new Error(
				[
					"Cannot read Messages database.",
					"Grant Full Disk Access to your terminal app:",
					"  System Settings → Privacy & Security → Full Disk Access → + Terminal",
				].join("\n"),
			);
		}
		throw e;
	}
}

/**
 * Get new messages since lastRowId.
 */
export function getNewMessages(db: Database.Database, lastRowId: number): IncomingMessage[] {
	const stmt = db.prepare(`
		SELECT m.ROWID as rowid, m.text, m.is_from_me, h.id as handle,
			datetime(m.date / 1000000000 + 978307200, 'unixepoch', 'localtime') as ts
		FROM message m
		LEFT JOIN handle h ON m.handle_id = h.ROWID
		WHERE m.ROWID > ?
			AND m.text IS NOT NULL
			AND m.text != ''
		ORDER BY m.ROWID ASC
	`);

	const rows = stmt.all(lastRowId) as any[];
	return rows.map((r) => ({
		rowid: r.rowid,
		text: r.text,
		handle: r.handle ?? "",
		isFromMe: r.is_from_me === 1,
		timestamp: r.ts,
	}));
}

/**
 * Get the current max ROWID (for initializing state to skip old messages).
 */
export function getMaxRowId(db: Database.Database): number {
	const row = db.prepare("SELECT MAX(ROWID) as maxId FROM message").get() as any;
	return row?.maxId ?? 0;
}

/**
 * Send an iMessage via AppleScript.
 */
/**
 * Send an iMessage via AppleScript. Returns the actual text sent (may be truncated).
 */
export function sendMessage(text: string, recipient: string, maxLength: number = 2000): string {
	let msg = text;
	if (msg.length > maxLength) {
		msg = msg.slice(0, maxLength - 20) + "\n\n… (truncated)";
	}

	// Escape for AppleScript string
	const escaped = msg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

	const script = `tell application "Messages" to send "${escaped}" to buddy "${recipient}" of (1st account whose service type = iMessage)`;

	try {
		execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
			timeout: 15000,
			stdio: "pipe",
		});
	} catch (e: any) {
		// Fallback: try participant-based addressing
		try {
			const script2 = `
				tell application "Messages"
					set targetService to 1st account whose service type = iMessage
					set targetBuddy to participant "${recipient}" of targetService
					send "${escaped}" to targetBuddy
				end tell
			`;
			execSync(`osascript -e '${script2.replace(/'/g, "'\\''")}'`, {
				timeout: 15000,
				stdio: "pipe",
			});
		} catch {
			throw new Error(`Failed to send iMessage to ${recipient}: ${e.message}`);
		}
	}
	return msg;
}

/**
 * Check if a sender handle is in the allowlist.
 */
export function isAllowedSender(handle: string, allowedSenders: string[]): boolean {
	if (allowedSenders.length === 0) return false;
	return allowedSenders.some((s) => s === handle || s === "*");
}

/**
 * Bridge — polls the Messages DB and dispatches to a handler.
 */
export class MessageBridge {
	private db: Database.Database;
	private state: PimessageState;
	private running = false;
	private config: PimessageConfig;
	private handler: MessageHandler;
	/** Track recently sent messages to avoid processing our own replies (self-chat creates is_from_me=0 copies) */
	private recentSent: Set<string> = new Set();

	constructor(config: PimessageConfig, handler: MessageHandler) {
		this.config = config;
		this.handler = handler;
		this.db = openMessagesDb();
		this.state = loadState();

		// Initialize to current max to skip old messages
		if (this.state.lastRowId === 0) {
			this.state.lastRowId = getMaxRowId(this.db);
			saveState(this.state);
		}
	}

	/** Mark a message as sent by us so the self-chat echo gets skipped */
	trackSent(text: string): void {
		this.recentSent.add(text);
		// Clean up after 60s to avoid memory leak
		setTimeout(() => this.recentSent.delete(text), 60000);
	}

	async start(): Promise<void> {
		this.running = true;
		while (this.running) {
			await this.poll();
			await sleep(this.config.pollInterval);
		}
	}

	stop(): void {
		this.running = false;
		try {
			this.db.close();
		} catch {
			/* ignore */
		}
	}

	get isRunning(): boolean {
		return this.running;
	}

	get lastRowId(): number {
		return this.state.lastRowId;
	}

	private async poll(): Promise<void> {
		let messages: IncomingMessage[];
		try {
			messages = getNewMessages(this.db, this.state.lastRowId);
		} catch {
			return;
		}

		for (const msg of messages) {
			this.state.lastRowId = msg.rowid;
			saveState(this.state);

			// Skip our own messages (sent copy)
			if (msg.isFromMe) continue;

			// Skip echo copies of messages we sent via AppleScript (self-chat creates is_from_me=0 duplicates)
			if (this.recentSent.has(msg.text)) {
				this.recentSent.delete(msg.text);
				continue;
			}

			// Check sender allowlist
			if (!msg.handle || !isAllowedSender(msg.handle, this.config.allowedSenders)) continue;

			// Check trigger prefix
			if (this.config.trigger) {
				if (!msg.text.startsWith(this.config.trigger)) continue;
			}

			await this.handler(msg);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
