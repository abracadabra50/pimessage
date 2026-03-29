#!/usr/bin/env node
/**
 * pimessage daemon — headless iMessage → pi bridge
 *
 * Self-chat safe: tracks sent text to skip echoes. Deletes echo rows for clean UI.
 * Uses stdin:ignore for pi spawn (pi hangs on piped stdin).
 */

import Database from "better-sqlite3";
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".pimessage");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const STATE_FILE = join(CONFIG_DIR, "state.json");
const LOG_FILE = join(CONFIG_DIR, "daemon.log");
const DB_PATH = join(homedir(), "Library/Messages/chat.db");

const DEFAULT_CONFIG = {
	allowedSenders: [],
	trigger: "",
	workingDirectory: homedir(),
	pollInterval: 3000,
	maxResponseLength: 2000,
	piFlags: [],
	provider: null,
	model: null,
	timeout: 300,
	logLevel: "info",
};

function loadConfig() {
	mkdirSync(CONFIG_DIR, { recursive: true });
	if (existsSync(CONFIG_FILE)) {
		try { return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, "utf8")) }; }
		catch { return { ...DEFAULT_CONFIG }; }
	}
	return { ...DEFAULT_CONFIG };
}

function loadState() {
	if (existsSync(STATE_FILE)) {
		try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
		catch {}
	}
	return { lastRowId: 0 };
}

function saveState(s) {
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(s));
}

function log(level, ...args) {
	const ts = new Date().toISOString();
	const line = `[${ts}] [${level.toUpperCase()}] ${args.join(" ")}`;
	console.log(line);
	try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

// ─── iMessage send + cleanup ──────────────────────────────────────────────────

function sendImessage(text, recipient, maxLength = 2000) {
	let msg = text;
	if (msg.length > maxLength) {
		msg = msg.slice(0, maxLength - 20) + "\n\n… (truncated)";
	}
	const escaped = msg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
	const script = `tell application "Messages" to send "${escaped}" to buddy "${recipient}" of (1st account whose service type = iMessage)`;
	execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 15000, stdio: "pipe" });
	return msg;
}

/**
 * Delete a message row from chat.db and refresh Messages.app.
 * This removes the duplicate "received" echo in self-chat.
 */
function deleteMessageRow(rowid) {
	try {
		const writeDb = new Database(DB_PATH, { fileMustExist: true });
		writeDb.prepare("DELETE FROM message WHERE ROWID = ?").run(rowid);
		writeDb.close();
	} catch (e) {
		log("debug", `Could not delete row ${rowid}: ${e.message}`);
	}
}

// ─── Self-chat echo tracking ──────────────────────────────────────────────────
// When you send to yourself, macOS creates:
//   ROWID N:   is_from_me=1, text="" (the sent row — AppleScript leaves text blank)
//   ROWID N+1: is_from_me=0, text="actual text" (the echo — this shows as grey bubble)
// We track sent text so we can identify and delete the echo.

const sentTexts = new Set();
function trackSent(text) {
	sentTexts.add(text);
	setTimeout(() => sentTexts.delete(text), 60000);
}

// ─── Pi execution ─────────────────────────────────────────────────────────────

function runPi(prompt, config) {
	return new Promise((resolve) => {
		const args = [
			"-p", prompt,
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
		];
		if (config.provider) args.push("--provider", config.provider);
		if (config.model) args.push("--model", config.model);
		if (config.piFlags.length > 0) args.push(...config.piFlags);

		const child = spawn("pi", args, {
			cwd: config.workingDirectory,
			env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],  // stdin MUST be 'ignore' — pi hangs on piped stdin
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			resolve("⏱ Timed out.");
		}, config.timeout * 1000);

		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(stdout.trim() || stderr.trim() || `(exit code ${code})`);
		});

		child.on("error", (e) => {
			clearTimeout(timer);
			resolve(`Error: ${e.message}`);
		});
	});
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default async function startDaemon() {
	const config = loadConfig();

	console.log(`
┌──────────────────────────────────────────┐
│          📱 pimessage daemon             │
└──────────────────────────────────────────┘
`);

	if (config.allowedSenders.length === 0) {
		console.error("❌ No allowed senders. Run: pimessage allow +1234567890");
		process.exit(1);
	}

	console.log(`  Senders: ${config.allowedSenders.join(", ")}`);
	console.log(`  Trigger: ${config.trigger ? `"${config.trigger}"` : "(any message)"}`);
	console.log(`  CWD:     ${config.workingDirectory}`);
	console.log(`  Timeout: ${config.timeout}s\n`);

	let db;
	try {
		db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
	} catch {
		console.error("❌ Cannot read Messages database.");
		console.error("   System Settings → Privacy & Security → Full Disk Access → + Terminal");
		process.exit(1);
	}

	let state = loadState();
	if (state.lastRowId === 0) {
		const row = db.prepare("SELECT MAX(ROWID) as maxId FROM message").get();
		state.lastRowId = row?.maxId ?? 0;
		saveState(state);
		log("info", `Initialized at ROWID ${state.lastRowId}`);
	}

	console.log("🟢 Listening…\n");

	let running = true;
	process.on("SIGINT", () => { console.log("\n👋 Shutting down…"); running = false; });
	process.on("SIGTERM", () => { running = false; });

	const stmt = db.prepare(`
		SELECT m.ROWID as rowid, m.text, m.is_from_me, h.id as handle
		FROM message m
		LEFT JOIN handle h ON m.handle_id = h.ROWID
		WHERE m.ROWID > ?
			AND m.text IS NOT NULL
			AND m.text != ''
		ORDER BY m.ROWID ASC
	`);

	while (running) {
		try {
			const messages = stmt.all(state.lastRowId);

			const pending = [];
			for (const msg of messages) {
				state.lastRowId = msg.rowid;
				saveState(state);

				// Skip sent copies (is_from_me=1)
				if (msg.is_from_me) continue;

				// Skip + delete echoes of messages WE sent via AppleScript
				if (sentTexts.has(msg.text)) {
					sentTexts.delete(msg.text);
					deleteMessageRow(msg.rowid);
					log("debug", `Deleted echo row ${msg.rowid}: ${msg.text.slice(0, 30)}`);
					continue;
				}

				if (!msg.handle) continue;
				if (!config.allowedSenders.some((s) => s === msg.handle || s === "*")) continue;

				let prompt = msg.text;
				if (config.trigger) {
					if (!prompt.startsWith(config.trigger)) continue;
					prompt = prompt.slice(config.trigger.length).trim();
				}
				if (!prompt) continue;

				pending.push({ handle: msg.handle, prompt, rowid: msg.rowid });
			}

			if (pending.length === 0) {
				await sleep(config.pollInterval);
				continue;
			}

			const handle = pending[0].handle;
			const prompt = pending.length === 1
				? pending[0].prompt
				: pending.map((p) => p.prompt).join("\n");

			log("info", `📥 ${handle}: ${prompt.slice(0, 100)}${prompt.length > 100 ? "…" : ""}`);

			// Also delete the is_from_me=0 echo of the user's own message
			// so the conversation shows: [user blue bubble] → [response blue bubble]
			// Skip the first one (that's the one we're processing), delete duplicates
			if (pending.length === 1) {
				// For self-chat: the user's message has both is_from_me=1 (already skipped)
				// and is_from_me=0 (which we process). We keep the is_from_me=0 as it shows
				// as a grey bubble from "them". This is fine — it's the prompt.
			}

			// Run pi
			const response = await runPi(prompt, config);
			log("info", `✅ ${response.length} chars`);

			// Send response + track for echo deletion
			try {
				const sent = sendImessage(response, handle, config.maxResponseLength);
				trackSent(sent);
				log("info", `📤 Sent to ${handle}`);
			} catch (e) {
				log("error", `Send failed: ${e.message}`);
			}

			// Wait for DB to flush sent+echo rows before next poll
			await sleep(1500);
		} catch (e) {
			log("error", `Poll error: ${e.message}`);
		}

		await sleep(config.pollInterval);
	}

	db.close();
	console.log("✅ Stopped.");
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

if (process.argv[1]?.includes("daemon")) {
	startDaemon().catch((e) => {
		console.error("Fatal:", e);
		process.exit(1);
	});
}
