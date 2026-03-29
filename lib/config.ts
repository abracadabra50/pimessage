/**
 * pimessage config — shared between extension and CLI daemon
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".pimessage");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const STATE_FILE = join(CONFIG_DIR, "state.json");
export const LOG_FILE = join(CONFIG_DIR, "pimessage.log");
export const DB_PATH = join(homedir(), "Library/Messages/chat.db");

export interface PimessageConfig {
	/** Allowed sender handles (phone numbers or Apple ID emails). Empty = reject all. */
	allowedSenders: string[];
	/** Message prefix that triggers processing. Default: none (all messages processed). */
	trigger: string;
	/** Working directory for pi commands (daemon mode only). */
	workingDirectory: string;
	/** Poll interval in milliseconds. */
	pollInterval: number;
	/** Max response length in chars (iMessage gets wonky past ~2000). */
	maxResponseLength: number;
	/** Pi CLI flags for daemon mode. */
	piFlags: string[];
	/** Provider override for daemon mode. */
	provider: string | null;
	/** Model override for daemon mode. */
	model: string | null;
	/** Timeout for pi commands in seconds. */
	timeout: number;
	/** Log level. */
	logLevel: "info" | "debug" | "error";
}

export const DEFAULT_CONFIG: PimessageConfig = {
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

export function loadConfig(): PimessageConfig {
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

export function saveConfig(cfg: PimessageConfig): void {
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

export interface PimessageState {
	lastRowId: number;
}

export function loadState(): PimessageState {
	if (existsSync(STATE_FILE)) {
		try {
			return JSON.parse(readFileSync(STATE_FILE, "utf8"));
		} catch {
			/* ignore */
		}
	}
	return { lastRowId: 0 };
}

export function saveState(s: PimessageState): void {
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(s));
}
