# @superwhisper/opencode

Superwhisper voice integration plugin for [OpenCode](https://opencode.ai).

Get voice notifications when your AI coding tasks complete, and respond with your voice. Your voice response is sent back to OpenCode as the next prompt, creating a hands-free coding loop.

## Requirements

- [OpenCode](https://opencode.ai) 1.x, or the OpenCode 2 preview (`opencode2`)
- [Superwhisper](https://superwhisper.com) app for macOS

## Installation

```bash
curl -fsSL https://superwhisper.com/install-opencode.sh | bash
```

The script registers the plugin with every OpenCode CLI it finds:

| CLI | Command it runs |
|-----|-----------------|
| OpenCode 1.3.4+ | `opencode plugin -g -f @superwhisper/opencode` |
| OpenCode 1.0–1.3.3 | adds the plugin to `plugin` in `~/.config/opencode/opencode.json` |
| OpenCode 2 (`opencode2`, `@opencode-ai/cli`) | `opencode2 plugin add @superwhisper/opencode` |

Or add it to `~/.config/opencode/opencode.json` yourself. OpenCode 1.x reads `plugin`, OpenCode 2 reads `plugins`:

```json
{
  "plugin": ["@superwhisper/opencode"],
  "plugins": ["@superwhisper/opencode"]
}
```

## How It Works

```
You speak → OpenCode works → Plugin notifies Superwhisper → You speak back → loop
```

1. **Task completes** → OpenCode reports the turn finished
2. **Plugin extracts the response** → fetches the last assistant message
3. **Plugin notifies Superwhisper** → writes the message to a temp file and a payload to Superwhisper's inbox
4. **Superwhisper shows notification** → displays summary with voice recording UI
5. **You speak your response** → Superwhisper transcribes and writes to response file
6. **Plugin reads response** → polls the response file, sends back to OpenCode
7. **OpenCode continues** → processes your voice input as the next instruction

## OpenCode 1 and 2

One package serves both plugin APIs:

- `@superwhisper/opencode` (package root) default-exports the 1.x plugin function. OpenCode 1.0–1.2 calls every root export as a plugin, so the root exports nothing else.
- `@superwhisper/opencode/server` default-exports `{ id, server, setup }`. OpenCode 1.3+ loads `./server` and calls `server`; OpenCode 2 calls `setup`.

Both adapters map their events into the same engine (`src/engine.ts`), so Superwhisper sees the same payloads either way.

## Events

| Superwhisper status | OpenCode 1.x | OpenCode 2 |
|---------------------|--------------|------------|
| `completed` | `session.idle` | `session.execution.succeeded` |
| `error` | `session.error` | `session.execution.failed` |
| `permission` | `permission.asked` (1.0: `permission.updated`) | `permission.asked` |
| `question` | `question.asked` | `form.created` (forms where every field has options) |

OpenCode 2 has no plugin API for answering forms, so the plugin answers them over the local service's HTTP API. It reads the URL and password from `~/.local/state/opencode/service.json`, and only when that file's `pid` matches the plugin's own process. Forms with free-text, number or conditional fields stay in the OpenCode UI.

## Controlling Superwhisper During a Session

You can ask the agent to enable or disable Superwhisper voice notifications at any time during a session. The plugin exposes a `superwhisper_toggle` tool that the agent will use automatically when instructed.

**Disable Superwhisper for the current session:**
> "Disable Superwhisper" / "Turn off voice notifications" / "Stop Superwhisper"

**Re-enable Superwhisper for the current session:**
> "Enable Superwhisper" / "Turn voice notifications back on" / "Re-enable Superwhisper"

The toggle is session-scoped — it only affects the current OpenCode session and resets when you start a new one.

## Development

```bash
bun install
bun test
bun run typecheck
```

### Local Testing

Build and install to your local OpenCode plugin folder:

```bash
bun run install-local
```

Or watch for changes and auto-install on save:

```bash
bun run dev
```

Both commands bundle the plugin and copy `dist/server.js` to `~/.config/opencode/plugin/superwhisper.js` (OpenCode 1.3+). OpenCode picks it up on next session. For OpenCode 2, point `plugins` at a directory containing a `server.js` that re-exports `dist/server.js`.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPERWHISPER_DEBUG` | unset | Set to `1` to enable debug logging (outputs to OpenCode's log) |

### Project Structure

```
src/
  index.ts        # Package root: OpenCode 1.x plugin function
  server.ts       # ./server: { id, server, setup } for OpenCode 1.3+ and 2
  v1.ts           # OpenCode 1.x adapter (hooks, event mapping, replies)
  v2.ts           # OpenCode 2 adapter (setup, event mapping, forms)
  engine.ts       # Version-independent notification/poll state machine
  inbox.ts        # Superwhisper file inbox delivery
  system.ts       # pgrep/open/git via child_process
  types.ts        # Engine events, Host interface, constants
  message.ts      # Message extraction and summary
  poll.ts         # Response file polling
  normalize.ts    # Question/permission response normalization
  *.test.ts       # Tests
```

## License

MIT
