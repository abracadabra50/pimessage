#!/usr/bin/env node
/**
 * pimessage CLI — standalone daemon and management tool
 *
 * Usage:
 *   pimessage                   Start the bridge daemon (foreground)
 *   pimessage allow <handle>    Add allowed sender
 *   pimessage deny <handle>     Remove allowed sender
 *   pimessage config            Show config
 *   pimessage set <key> <val>   Set config value
 *   pimessage test <handle>     Send test message
 *   pimessage reset             Reset message pointer
 *   pimessage install           Install as launchd service
 *   pimessage uninstall         Uninstall launchd service
 *   pimessage status            Check service status
 *   pimessage help              Show help
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(homedir(), ".pimessage");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const STATE_FILE = join(CONFIG_DIR, "state.json");
const LOG_FILE = join(CONFIG_DIR, "pimessage.log");
const PLIST_NAME = "com.pimessage.agent";
const PLIST_PATH = join(homedir(), "Library/LaunchAgents", `${PLIST_NAME}.plist`);
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
		try {
			return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, "utf8")) };
		} catch {
			return { ...DEFAULT_CONFIG };
		}
	}
	return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function saveState(s) {
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(s));
}

function sendTestMessage(text, recipient) {
	const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
	const script = `tell application "Messages" to send "${escaped}" to buddy "${recipient}" of (1st account whose service type = iMessage)`;
	execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 15000, stdio: "pipe" });
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const cmd = args[0]?.toLowerCase();

switch (cmd) {
	case "allow": {
		const handle = args[1];
		if (!handle) {
			console.error("Usage: pimessage allow <phone-or-email>");
			process.exit(1);
		}
		const cfg = loadConfig();
		if (!cfg.allowedSenders.includes(handle)) {
			cfg.allowedSenders.push(handle);
			saveConfig(cfg);
			console.log(`✅ Added ${handle}`);
		} else {
			console.log(`ℹ️  ${handle} already allowed`);
		}
		console.log(`   Allowed: ${cfg.allowedSenders.join(", ")}`);
		break;
	}

	case "deny":
	case "remove": {
		const handle = args[1];
		if (!handle) {
			console.error("Usage: pimessage deny <phone-or-email>");
			process.exit(1);
		}
		const cfg = loadConfig();
		cfg.allowedSenders = cfg.allowedSenders.filter((s) => s !== handle);
		saveConfig(cfg);
		console.log(`✅ Removed ${handle}`);
		console.log(`   Allowed: ${cfg.allowedSenders.join(", ") || "(none)"}`);
		break;
	}

	case "config": {
		const cfg = loadConfig();
		console.log("\n📱 pimessage config:\n");
		for (const [k, v] of Object.entries(cfg)) {
			const val = Array.isArray(v) ? v.join(", ") || "(none)" : v ?? "(not set)";
			console.log(`  ${k}: ${val}`);
		}
		console.log(`\n  Config: ${CONFIG_FILE}`);
		console.log(`  State:  ${STATE_FILE}`);
		console.log(`  Log:    ${LOG_FILE}\n`);
		break;
	}

	case "set": {
		const key = args[1];
		let value = args.slice(2).join(" ");
		if (!key || value === undefined || value === "") {
			console.error("Usage: pimessage set <key> <value>");
			console.error("  Keys: trigger, workingDirectory, timeout, pollInterval, maxResponseLength, provider, model, logLevel");
			process.exit(1);
		}
		const cfg = loadConfig();
		if (!(key in DEFAULT_CONFIG)) {
			console.error(`Unknown key: ${key}`);
			process.exit(1);
		}
		if (value === "null") value = null;
		else if (value === "true") value = true;
		else if (value === "false") value = false;
		else if (/^\d+$/.test(value)) value = parseInt(value);
		cfg[key] = value;
		saveConfig(cfg);
		console.log(`✅ ${key} = ${JSON.stringify(value)}`);
		break;
	}

	case "test": {
		const recipient = args[1];
		if (!recipient) {
			console.error("Usage: pimessage test <phone-or-email>");
			process.exit(1);
		}
		try {
			sendTestMessage("🧪 pimessage test — if you see this, sending works!", recipient);
			console.log(`✅ Test message sent to ${recipient}`);
		} catch (e) {
			console.error(`❌ Failed: ${e.message}`);
		}
		break;
	}

	case "reset": {
		saveState({ lastRowId: 0 });
		console.log("✅ State reset. Will skip existing messages on next start.");
		break;
	}

	case "install": {
		const nodePath = process.execPath;
		const daemonPath = join(__dirname, "daemon.mjs");

		const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${daemonPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(CONFIG_DIR, "stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(CONFIG_DIR, "stderr.log")}</string>
</dict>
</plist>`;

		mkdirSync(join(homedir(), "Library/LaunchAgents"), { recursive: true });
		writeFileSync(PLIST_PATH, plist);
		try {
			execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, { stdio: "pipe" });
		} catch {}
		execSync(`launchctl load "${PLIST_PATH}"`, { stdio: "pipe" });
		console.log(`✅ Installed as launchd service`);
		console.log(`   Plist: ${PLIST_PATH}`);
		console.log(`   Logs:  ${CONFIG_DIR}/stdout.log`);
		console.log(`   Starts at login. Use 'pimessage uninstall' to remove.`);
		break;
	}

	case "uninstall": {
		try {
			execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, { stdio: "pipe" });
		} catch {}
		if (existsSync(PLIST_PATH)) unlinkSync(PLIST_PATH);
		console.log("✅ Service uninstalled");
		break;
	}

	case "status": {
		try {
			const out = execSync(`launchctl list 2>/dev/null | grep ${PLIST_NAME}`, { stdio: "pipe" }).toString().trim();
			if (out) {
				const parts = out.split(/\s+/);
				console.log(`🟢 Service loaded (PID: ${parts[0] === "-" ? "not running" : parts[0]}, last exit: ${parts[1]})`);
			} else {
				console.log("🔴 Service not loaded");
			}
		} catch {
			console.log("🔴 Service not loaded");
		}
		const cfg = loadConfig();
		console.log(`   Senders: ${cfg.allowedSenders.join(", ") || "(none)"}`);
		console.log(`   Trigger: ${cfg.trigger ? `"${cfg.trigger}"` : "(any message)"}`);
		break;
	}

	case "log":
	case "logs": {
		const n = parseInt(args[1]) || 30;
		const logPath = args[2] === "err" ? join(CONFIG_DIR, "stderr.log") : join(CONFIG_DIR, "stdout.log");
		if (existsSync(logPath)) {
			const lines = readFileSync(logPath, "utf8").split("\n");
			console.log(lines.slice(-n).join("\n"));
		} else {
			console.log("No log file yet.");
		}
		break;
	}

	case "help":
	case "--help":
	case "-h": {
		console.log(`
📱 pimessage — Control pi coding agent via iMessage

Standalone daemon (headless, uses pi -p):
  pimessage                   Start daemon (foreground)
  pimessage install           Install as background service (launchd)
  pimessage uninstall         Remove background service
  pimessage status            Check service status
  pimessage log [n] [err]     Show last n log lines

Pi extension (in-session, interactive):
  pi -e pimessage             Load as extension
  /pimessage:allow <handle>   Allow a sender
  /pimessage:start            Start bridge
  /pimessage                  Show status

Management:
  pimessage allow <handle>    Add allowed sender (+phone or email)
  pimessage deny <handle>     Remove allowed sender
  pimessage config            Show configuration
  pimessage set <key> <value> Update config value
  pimessage test <handle>     Send a test iMessage
  pimessage reset             Reset message pointer

Setup:
  1. System Settings → Privacy & Security → Full Disk Access → + Terminal
  2. pimessage allow +1234567890
  3. pimessage                    # standalone daemon
     OR
     pi -e pimessage              # as pi extension, then /pimessage:start
`);
		break;
	}

	case undefined: {
		// Default: start daemon mode
		const { default: startDaemon } = await import("./daemon.mjs");
		await startDaemon();
		break;
	}

	default:
		console.error(`Unknown command: ${cmd}. Run 'pimessage help' for usage.`);
		process.exit(1);
}
