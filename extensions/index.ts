/**
 * pimessage — pi extension for iMessage bridge
 *
 * Monitors ~/Library/Messages/chat.db and forwards incoming messages
 * as prompts to the active pi session. Responses are sent back via iMessage.
 *
 * Commands:
 *   /imessage              — Show status and config
 *   /imessage:allow        — Add an allowed sender
 *   /imessage:deny         — Remove an allowed sender
 *   /imessage:start        — Start the bridge
 *   /imessage:stop         — Stop the bridge
 *   /imessage:set          — Set a config value
 *   /imessage:test         — Send a test message
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig, saveConfig, loadState, saveState, type PimessageConfig } from "../lib/config.js";
import { MessageBridge, sendMessage, getMaxRowId, openMessagesDb } from "../lib/bridge.js";

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	let bridge: MessageBridge | null = null;
	let messageCount = 0;

	// ─── Status widget ────────────────────────────────────────────────────────

	function updateStatus(ctx: any) {
		if (!ctx?.hasUI) return;
		const theme = ctx.ui.theme;
		if (bridge?.isRunning) {
			const dot = theme.fg("success", "●");
			const text = theme.fg("dim", ` imessage (${messageCount} msgs)`);
			ctx.ui.setStatus("pimessage", dot + text);
		} else {
			ctx.ui.setStatus("pimessage", theme.fg("dim", "○ imessage off"));
		}
	}

	// ─── Bridge lifecycle ─────────────────────────────────────────────────────

	function startBridge(ctx: any): string {
		if (bridge?.isRunning) return "Bridge is already running.";
		if (config.allowedSenders.length === 0) {
			return "No allowed senders. Run /imessage:allow <phone-or-email> first.";
		}

		try {
			bridge = new MessageBridge(config, async (msg) => {
				messageCount++;
				updateStatus(ctx);

				// Strip trigger prefix if present
				let prompt = msg.text;
				if (config.trigger && prompt.startsWith(config.trigger)) {
					prompt = prompt.slice(config.trigger.length).trim();
				}
				if (!prompt) return;

				// Send acknowledgment
				try {
					sendMessage("⏳ Processing…", msg.handle, config.maxResponseLength);
				} catch {
					/* best effort */
				}

				// Forward to the active pi session as a user message
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });

				// We need to capture the response — listen for the next agent_end
				const responseListener = new Promise<string>((resolve) => {
					const cleanup = pi.on("agent_end", async (event) => {
						cleanup(); // unsubscribe

						// Extract last assistant text from the messages
						const messages = event.messages ?? [];
						let response = "";
						for (let i = messages.length - 1; i >= 0; i--) {
							const m = messages[i];
							if (m.role === "assistant") {
								for (const part of m.content) {
									if (part.type === "text") {
										response = part.text;
										break;
									}
								}
								if (response) break;
							}
						}
						resolve(response || "(no response)");
					});

					// Timeout after config.timeout seconds
					setTimeout(() => {
						cleanup();
						resolve("(timed out)");
					}, config.timeout * 1000);
				});

				const response = await responseListener;

				// Send response back via iMessage
				try {
					sendMessage(response, msg.handle, config.maxResponseLength);
				} catch (e: any) {
					try {
						sendMessage(`❌ Failed to send response: ${e.message}`, msg.handle, config.maxResponseLength);
					} catch {
						/* give up */
					}
				}
			});

			bridge.start().catch(() => {
				bridge = null;
				updateStatus(ctx);
			});

			updateStatus(ctx);
			return `Bridge started. Listening for messages from ${config.allowedSenders.join(", ")}${config.trigger ? ` (trigger: "${config.trigger}")` : ""}.`;
		} catch (e: any) {
			return `Failed to start bridge: ${e.message}`;
		}
	}

	function stopBridge(ctx: any): string {
		if (!bridge?.isRunning) return "Bridge is not running.";
		bridge.stop();
		bridge = null;
		updateStatus(ctx);
		return "Bridge stopped.";
	}

	// ─── Commands ─────────────────────────────────────────────────────────────

	// /imessage — status
	pi.registerCommand("imessage", {
		description: "Show iMessage bridge status",
		handler: async (_args, ctx) => {
			config = loadConfig();
			const lines = [
				`📱 pimessage ${bridge?.isRunning ? "🟢 running" : "🔴 stopped"}`,
				``,
				`  Senders:  ${config.allowedSenders.join(", ") || "(none)"}`,
				`  Trigger:  ${config.trigger ? `"${config.trigger}"` : "(any message)"}`,
				`  Messages: ${messageCount}`,
				`  Timeout:  ${config.timeout}s`,
				`  Max len:  ${config.maxResponseLength} chars`,
				``,
				`  /imessage:allow <handle>  — add sender`,
				`  /imessage:start           — start bridge`,
				`  /imessage:stop            — stop bridge`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// /imessage:allow — add sender
	pi.registerCommand("imessage:allow", {
		description: "Allow an iMessage sender (phone or email)",
		handler: async (args, ctx) => {
			const handle = args?.trim();
			if (!handle) {
				ctx.ui.notify("Usage: /imessage:allow +447123456789 or /imessage:allow me@icloud.com", "error");
				return;
			}
			config = loadConfig();
			if (!config.allowedSenders.includes(handle)) {
				config.allowedSenders.push(handle);
				saveConfig(config);
			}
			ctx.ui.notify(`✅ Allowed: ${config.allowedSenders.join(", ")}`, "info");
		},
	});

	// /imessage:deny — remove sender
	pi.registerCommand("imessage:deny", {
		description: "Remove an iMessage sender from the allowlist",
		handler: async (args, ctx) => {
			const handle = args?.trim();
			if (!handle) {
				ctx.ui.notify("Usage: /imessage:deny +447123456789", "error");
				return;
			}
			config = loadConfig();
			config.allowedSenders = config.allowedSenders.filter((s) => s !== handle);
			saveConfig(config);
			ctx.ui.notify(`✅ Removed. Allowed: ${config.allowedSenders.join(", ") || "(none)"}`, "info");
		},
	});

	// /imessage:start — start bridge
	pi.registerCommand("imessage:start", {
		description: "Start the iMessage bridge",
		handler: async (_args, ctx) => {
			config = loadConfig();
			const result = startBridge(ctx);
			ctx.ui.notify(result, bridge?.isRunning ? "info" : "error");
		},
	});

	// /imessage:stop — stop bridge
	pi.registerCommand("imessage:stop", {
		description: "Stop the iMessage bridge",
		handler: async (_args, ctx) => {
			const result = stopBridge(ctx);
			ctx.ui.notify(result, "info");
		},
	});

	// /imessage:set — set config value
	pi.registerCommand("imessage:set", {
		description: "Set a pimessage config value (e.g. trigger, timeout, maxResponseLength)",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			const key = parts[0];
			const value = parts.slice(1).join(" ");

			if (!key || !value) {
				ctx.ui.notify(
					[
						"Usage: /imessage:set <key> <value>",
						"",
						"Keys: trigger, timeout, maxResponseLength, pollInterval, logLevel",
						'Example: /imessage:set trigger "/ask "',
						"Example: /imessage:set timeout 600",
					].join("\n"),
					"info",
				);
				return;
			}

			config = loadConfig();
			const validKeys = ["trigger", "timeout", "maxResponseLength", "pollInterval", "logLevel"];
			if (!validKeys.includes(key)) {
				ctx.ui.notify(`Unknown key: ${key}. Valid: ${validKeys.join(", ")}`, "error");
				return;
			}

			let parsed: any = value;
			if (value === "null" || value === '""' || value === "''") parsed = "";
			else if (/^\d+$/.test(value)) parsed = parseInt(value);

			(config as any)[key] = parsed;
			saveConfig(config);
			ctx.ui.notify(`✅ ${key} = ${JSON.stringify(parsed)}`, "info");
		},
	});

	// /imessage:test — send a test message
	pi.registerCommand("imessage:test", {
		description: "Send a test iMessage",
		handler: async (args, ctx) => {
			const recipient = args?.trim();
			if (!recipient) {
				ctx.ui.notify("Usage: /imessage:test +447123456789", "error");
				return;
			}
			try {
				sendMessage("🧪 pimessage test — if you see this, sending works!", recipient);
				ctx.ui.notify(`✅ Test message sent to ${recipient}`, "info");
			} catch (e: any) {
				ctx.ui.notify(`❌ ${e.message}`, "error");
			}
		},
	});

	// /imessage:reset — reset message pointer
	pi.registerCommand("imessage:reset", {
		description: "Reset message pointer to skip all existing messages",
		handler: async (_args, ctx) => {
			try {
				const db = openMessagesDb();
				const maxId = getMaxRowId(db);
				db.close();
				saveState({ lastRowId: maxId });
				ctx.ui.notify(`✅ Reset to ROWID ${maxId}. Old messages will be skipped.`, "info");
			} catch (e: any) {
				ctx.ui.notify(`❌ ${e.message}`, "error");
			}
		},
	});

	// ─── Lifecycle ────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (bridge?.isRunning) {
			bridge.stop();
			bridge = null;
		}
	});
}
