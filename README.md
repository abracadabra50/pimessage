<p align="center">
  <img src="https://em-content.zobj.net/source/apple/391/mobile-phone_1f4f1.png" alt="pimessage logo" width="96" />
</p>

<h1 align="center">pimessage</h1>

<p align="center">
  <strong>Control your AI coding agent from iMessage.</strong><br />
  Text a prompt from your iPhone → get a response back.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pimessage"><img alt="npm" src="https://img.shields.io/npm/v/pimessage?style=flat-square&color=cb3837" /></a>
  <a href="https://github.com/abracadabra50/pimessage/blob/master/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <a href="#"><img alt="macOS" src="https://img.shields.io/badge/platform-macOS-000?style=flat-square&logo=apple&logoColor=white" /></a>
  <a href="#"><img alt="pi package" src="https://img.shields.io/badge/pi-package-8B5CF6?style=flat-square" /></a>
  <a href="https://github.com/badlogic/pi-mono"><img alt="Built for pi" src="https://img.shields.io/badge/built%20for-pi%20coding%20agent-1a1a2e?style=flat-square" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#extension-mode">Extension</a> •
  <a href="#daemon-mode">Daemon</a> •
  <a href="#commands">Commands</a> •
  <a href="#configuration">Config</a> •
  <a href="#security">Security</a>
</p>

---

**pimessage** turns iMessage into a remote control for [pi](https://github.com/badlogic/pi-mono), the terminal coding agent. Start a refactor at your desk, check on it from the couch. Kick off a test suite from the train. Ask your agent to look something up while you're away from your Mac.

Works as a **pi extension** (messages flow into your live session with full context) or a **standalone daemon** (headless, each message is a fresh `pi -p` call).

## How It Works

```
iPhone                     Mac
  │                         │
  ├── iMessage ───────────► │  ~/Library/Messages/chat.db
  │                         │         │
  │                         │    pimessage (polls every 3s)
  │                         │         │
  │                         │    ┌────▼─────┐
  │                         │    │  pi agent │
  │                         │    └────┬─────┘
  │                         │         │
  │ ◄── iMessage ────────── │  AppleScript (osascript)
```

1. You text yourself from your iPhone
2. pimessage detects the new message in the local Messages database
3. Forwards it as a prompt to pi
4. Sends the response back as an iMessage via AppleScript

No servers. No APIs. No cloud relay. Everything stays local on your Mac.

## Quick Start

### 1. Grant Full Disk Access

The Messages database is sandboxed by macOS. Your terminal needs explicit permission.

> **System Settings → Privacy & Security → Full Disk Access → + Terminal**
>
> Restart Terminal after enabling.

### 2. Install

```bash
# As a pi package (recommended)
pi install git:github.com/abracadabra50/pimessage

# Or clone manually
git clone https://github.com/abracadabra50/pimessage.git
cd pimessage && npm install && npm link
```

### 3. Allow your phone number

```bash
pimessage allow +1234567890
```

### 4. Start the bridge

**Inside pi (extension mode):**
```bash
pi                      # extension loads automatically after install
/pimessage:start        # start the bridge
```

**Or standalone (daemon mode):**
```bash
pimessage               # foreground
pimessage install       # background service (survives reboots)
```

### 5. Text yourself

Open Messages on your iPhone and send yourself:

```
What files are in ~/projects?
```

You'll get "⏳ Processing…" immediately, then the full response.

---

## Extension Mode

When loaded as a pi extension, incoming iMessages are forwarded directly into your **active pi session**. The agent has full access to your project context, tools, conversation history — everything.

```bash
pi                          # start pi (extension auto-loads)
/pimessage:allow +1234567890
/pimessage:start
```

A status indicator appears in the footer: **● pimessage (3 msgs)** or **○ pimessage off**.

Best for: interactive work, long-running tasks, project-specific queries.

## Daemon Mode

The standalone daemon runs without an active pi session. Each incoming message spawns a fresh `pi -p` (non-interactive) call. Configure the working directory, model, and provider via config.

```bash
pimessage                   # foreground
pimessage install           # launchd service (starts at login)
pimessage uninstall         # remove service
pimessage status            # check if running
```

Best for: quick queries, monitoring, always-on availability.

### Extension vs Daemon

| | Extension | Daemon |
|:--|:----------|:-------|
| **Requires active pi?** | Yes | No |
| **Session context** | Full (files, history, tools) | None (fresh each message) |
| **Tool access** | All active tools | Default pi tools |
| **Model** | Current session model | Config or default |
| **Use case** | Interactive work, long tasks | Quick queries, monitoring |

---

## Commands

### Pi Extension Commands

| Command | Description |
|:--------|:------------|
| `/pimessage` | Show bridge status and config |
| `/pimessage:allow <handle>` | Add allowed sender (phone or Apple ID email) |
| `/pimessage:deny <handle>` | Remove allowed sender |
| `/pimessage:start` | Start the iMessage bridge |
| `/pimessage:stop` | Stop the bridge |
| `/pimessage:set <key> <value>` | Update a config value |
| `/pimessage:test <handle>` | Send a test iMessage |
| `/pimessage:reset` | Reset message pointer (skip old messages) |

### CLI Commands

| Command | Description |
|:--------|:------------|
| `pimessage` | Start daemon (foreground) |
| `pimessage allow <handle>` | Add allowed sender |
| `pimessage deny <handle>` | Remove allowed sender |
| `pimessage config` | Show all config |
| `pimessage set <key> <value>` | Update config value |
| `pimessage test <handle>` | Send a test iMessage |
| `pimessage reset` | Reset message pointer |
| `pimessage install` | Install as background service (launchd) |
| `pimessage uninstall` | Remove background service |
| `pimessage status` | Check service status |
| `pimessage log [n]` | Show last n log lines |
| `pimessage help` | Show help |

---

## Configuration

Config file: `~/.pimessage/config.json`

Edit directly or use `pimessage set <key> <value>` / `/pimessage:set <key> <value>`.

| Key | Default | Description |
|:----|:--------|:------------|
| `allowedSenders` | `[]` | Phone numbers or Apple ID emails to accept messages from |
| `trigger` | `""` | Message prefix filter. Empty = all messages processed |
| `timeout` | `300` | Command timeout in seconds |
| `maxResponseLength` | `2000` | Truncate responses beyond this (iMessage limit) |
| `pollInterval` | `3000` | How often to check for new messages (ms) |
| `workingDirectory` | `~` | Working directory for daemon mode |
| `provider` | `null` | Pi provider override (daemon mode) |
| `model` | `null` | Pi model override (daemon mode) |
| `logLevel` | `"info"` | Log verbosity: `error`, `info`, `debug` |

### Trigger prefix

By default, **every message** from an allowed sender is processed. Set a trigger to filter:

```bash
pimessage set trigger "/ask "
```

Now only messages starting with `/ask ` get forwarded. The prefix is stripped before sending to pi.

---

## Security

- **Allowlist only** — messages from non-allowed senders are silently ignored
- **Full Disk Access** — system-level macOS permission required to read Messages DB
- **No outbound processing** — the bridge never processes its own sent messages
- **Truncation** — responses are capped to prevent iMessage rendering issues
- **Local only** — no cloud relay, no external servers, everything stays on your Mac
- **Same permissions** — pi runs with your user permissions, same as when you use it at the terminal

---

## Requirements

- **macOS 12+** (Monterey or later)
- **[pi](https://github.com/badlogic/pi-mono)** installed (`npm i -g @mariozechner/pi-coding-agent`)
- **Full Disk Access** granted to Terminal (or your terminal app)
- **Messages.app** signed in with your Apple ID
- **Node.js 18+**

---

## Project Structure

```
pimessage/
├── package.json          # Pi package manifest (keywords: pi-package)
├── extensions/
│   └── index.ts          # Pi extension — commands, bridge, status widget
├── lib/
│   ├── config.ts         # Shared config & state management
│   └── bridge.ts         # Messages DB polling + AppleScript sending
└── bin/
    ├── cli.mjs           # CLI tool (allow, deny, config, install, etc.)
    └── daemon.mjs        # Headless daemon (uses pi -p)
```

---

## Troubleshooting

**"Cannot read Messages database"**
→ Grant Full Disk Access: System Settings → Privacy & Security → Full Disk Access → + Terminal. Restart Terminal.

**"No allowed senders"**
→ Run `pimessage allow +1234567890` with your phone number (include country code).

**Messages not being detected**
→ Make sure Messages.app is open and signed in. Check `pimessage log` for errors.

**AppleScript send failures**
→ Run `pimessage test +1234567890` to verify sending works. Messages.app must be open.

**Extension not loading in pi**
→ After `pi install`, restart pi or run `/reload`.

---

## Related

- [pi coding agent](https://github.com/badlogic/pi-mono) — the terminal coding agent pimessage extends
- [pi packages](https://shittycodingagent.ai/packages) — discover more pi extensions

---

## License

[MIT](LICENSE)
