#!/usr/bin/env node
/**
 * pimessage daemon — headless mode using pi -p
 *
 * Polls the Messages DB, passes prompts to `pi -p --no-session`, sends responses
 * back via iMessage. Self-chat safe (tracks sent messages to skip echoes).
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

// ─── iMessage sending ─────────────────────────────────────────────────────────

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

// ─── Self-chat echo tracking ──────────────────────────────────────────────────
// When you text yourself, macOS creates TWO rows: is_from_me=1 (sent) and
// is_from_me=0 (received echo). We track what we send so we can skip the echo.

const recentSent = new Set();
function trackSent(text) {
	recentSent.add(text);
	setTimeout(() => recentSent.delete(text), 60000);
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
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			resolve("⏱ Timed out — try a shorter prompt.");
		}, config.timeout * 1000);

		child.on("close", (code) => {
			clearTimeout(timer);
			const out = stdout.trim() || stderr.trim() || `(exit code ${code})`;
			resolve(out);
		});

		child.on("error", (e) => {
			clearTimeout(timer);
			resolve(`❌ Error: ${e.message}`);
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
	console.log(`  Timeout: ${config.timeout}s`);
	console.log(`  Poll:    ${config.pollInterval}ms`);
	console.log(`  Log:     ${LOG_FILE}\n`);

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
	let busy = false;
	process.on("SIGINT", () => { console.log("\n👋 Shutting down…"); running = false; });
	process.on("SIGTERM", () => { running = false; });

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

	while (running) {
		try {
			const messages = stmt.all(state.lastRowId);

			// Collect valid incoming prompts, advance state for all
			const pending = [];
			for (const msg of messages) {
				state.lastRowId = msg.rowid;
				saveState(state);

				if (msg.is_from_me) continue;
				if (!msg.handle) continue;

				// Skip echoes of our own sent messages
				if (recentSent.has(msg.text)) {
					recentSent.delete(msg.text);
					continue;
				}

				if (!config.allowedSenders.some((s) => s === msg.handle || s === "*")) continue;

				let prompt = msg.text;
				if (config.trigger) {
					if (!prompt.startsWith(config.trigger)) continue;
					prompt = prompt.slice(config.trigger.length).trim();
				}
				if (!prompt) continue;

				pending.push({ handle: msg.handle, prompt });
			}

			// Skip if already processing or nothing to do
			if (pending.length === 0 || busy) {
				await sleep(config.pollInterval);
				continue;
			}

			busy = true;
			const handle = pending[0].handle;

			// Batch multiple rapid-fire messages into one prompt
			const prompt = pending.length === 1
				? pending[0].prompt
				: pending.map((p) => p.prompt).join("\n");

			if (pending.length > 1) {
				log("info", `📥 ${handle}: batched ${pending.length} messages`);
			}
			log("info", `📥 ${handle}: ${prompt.slice(0, 100)}${prompt.length > 100 ? "…" : ""}`);

			// Ack
			try {
				const ack = sendImessage("⏳ Processing…", handle, config.maxResponseLength);
				trackSent(ack);
			} catch {}

			// Run pi
			const response = await runPi(prompt, config);
			log("info", `✅ Response: ${response.length} chars`);

			// Send response
			try {
				const sent = sendImessage(response, handle, config.maxResponseLength);
				trackSent(sent);
			} catch (e) {
				log("error", `Failed to send: ${e.message}`);
			}

			busy = false;
		} catch (e) {
			log("error", `Poll error: ${e.message}`);
			busy = false;
		}

		await sleep(config.pollInterval);
	}

	db.close();
	console.log("✅ Stopped.");
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// Auto-run when executed directly
if (process.argv[1]?.includes("daemon")) {
	startDaemon().catch((e) => {
		console.error("Fatal:", e);
		process.exit(1);
	});
}
