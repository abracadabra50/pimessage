# 📱 pimessage

Control [pi](https://github.com/badlogic/pi-mono) coding agent via iMessage. Text yourself a prompt from your iPhone, get a response back.

Works two ways:
- **Pi extension** — bridges iMessage into your active pi session (interactive, full tool access)
- **Standalone daemon** — runs headless using `pi -p` (no active session needed)

## How it works

1. Polls `~/Library/Messages/chat.db` for new messages from your allowlisted number
2. Forwards them as prompts to pi
3. Sends responses back via AppleScript (`osascript`)

```
iPhone                    Mac
  │                        │
  ├── iMessage ──────────► │ chat.db ──► pimessage ──► pi
  │                        │                            │
  │ ◄── iMessage ──────── │ ◄── AppleScript ◄──────────┘
```

## Setup

### 1. Grant Full Disk Access

The Messages database is sandboxed. Your terminal needs permission to read it.

**System Settings → Privacy & Security → Full Disk Access → + Terminal**

Restart Terminal after enabling.

### 2. Install

```bash
# As a pi package (recommended)
pi install git:github.com/AnotherZishworker/pimessage

# Or manually
git clone https://github.com/AnotherZishworker/pimessage.git
cd pimessage && npm install
```

### 3. Allow your phone number

```bash
# CLI
pimessage allow +447123456789

# Or inside pi
/imessage:allow +447123456789
```

### 4. Start

**As pi extension (recommended):**
```bash
pi  # start pi normally — extension loads automatically after install
/imessage:start
```

Messages go into your active session — full tool access, context, everything.

**As standalone daemon:**
```bash
pimessage           # foreground
pimessage install   # background service (survives reboots)
```

Uses `pi -p` under the hood — each message is a fresh non-interactive prompt.

### 5. Text yourself

```
What files are in ~/projects?
```

You'll get "⏳ Processing…" immediately, then the full response.

## Pi extension commands

| Command | Description |
|---------|-------------|
| `/imessage` | Show bridge status |
| `/imessage:allow <handle>` | Add allowed sender |
| `/imessage:deny <handle>` | Remove sender |
| `/imessage:start` | Start the bridge |
| `/imessage:stop` | Stop the bridge |
| `/imessage:set <key> <value>` | Update config |
| `/imessage:test <handle>` | Send test message |
| `/imessage:reset` | Reset message pointer |

## CLI commands

| Command | Description |
|---------|-------------|
| `pimessage` | Start daemon (foreground) |
| `pimessage allow <handle>` | Add allowed sender |
| `pimessage deny <handle>` | Remove sender |
| `pimessage config` | Show config |
| `pimessage set <key> <value>` | Update config |
| `pimessage test <handle>` | Send test message |
| `pimessage reset` | Reset message pointer |
| `pimessage install` | Install as launchd service |
| `pimessage uninstall` | Remove service |
| `pimessage status` | Check service status |
| `pimessage log [n]` | Show recent logs |

## Configuration

Config lives at `~/.pimessage/config.json`. Edit directly or use `pimessage set`:

| Key | Default | Description |
|-----|---------|-------------|
| `trigger` | `""` | Message prefix filter. Empty = process all messages. |
| `timeout` | `300` | Pi command timeout in seconds |
| `maxResponseLength` | `2000` | Truncate responses beyond this (iMessage limit) |
| `pollInterval` | `3000` | Database poll interval in ms |
| `workingDirectory` | `~` | CWD for daemon mode |
| `provider` | `null` | Pi provider override (daemon mode) |
| `model` | `null` | Pi model override (daemon mode) |

### Trigger prefix

By default, all messages from allowed senders are processed. Set a trigger to filter:

```bash
pimessage set trigger "/ask "
```

Now only messages starting with `/ask ` are forwarded. The prefix is stripped before sending to pi.

## Security

- Only messages from your allowlisted handles are processed
- Full Disk Access is required (system-level permission)
- The bridge never processes its own outgoing messages
- Responses are truncated to prevent iMessage issues with long texts
- In extension mode, the agent runs with the same permissions as your pi session
- In daemon mode, `pi -p` runs with your user permissions

## Extension vs Daemon

| | Extension | Daemon |
|--|-----------|--------|
| **Requires active pi?** | Yes | No |
| **Session context** | Full (files, history, tools) | None (fresh each message) |
| **Tool access** | All active tools | Default pi tools |
| **Model** | Current session model | Config or default |
| **Best for** | Interactive work, long tasks | Quick queries, monitoring |

## Requirements

- macOS 12+ (uses Messages.app database)
- pi installed (`npm i -g @mariozechner/pi-coding-agent`)
- Full Disk Access for Terminal
- Messages.app signed in with your Apple ID
- `better-sqlite3` (installed automatically)

## License

MIT
