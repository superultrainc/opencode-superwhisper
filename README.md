# @superwhisper/opencode

SuperWhisper voice integration plugin for [OpenCode](https://opencode.ai).

Get voice notifications when your AI coding tasks complete, and respond with your voice. Your voice response is sent back to OpenCode as the next prompt, creating a hands-free coding loop.

## Requirements

- [OpenCode](https://opencode.ai) v1.0+
- [SuperWhisper](https://superwhisper.com) app for macOS

## Installation

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["@superwhisper/opencode"]
}
```

OpenCode will resolve the plugin from npm automatically.

## How It Works

```
You speak → OpenCode works → Plugin notifies SuperWhisper → You speak back → loop
```

1. **Task completes** → OpenCode fires `session.idle`
2. **Plugin extracts the response** → fetches the last assistant message
3. **Plugin notifies SuperWhisper** → writes message to temp file, opens deeplink
4. **SuperWhisper shows notification** → displays summary with voice recording UI
5. **You speak your response** → SuperWhisper transcribes and writes to response file
6. **Plugin reads response** → polls the response file, sends back to OpenCode
7. **OpenCode continues** → processes your voice input as the next instruction

## Events

| OpenCode Event | SuperWhisper Status | Description |
|----------------|---------------------|-------------|
| `session.idle` | `completed` | Task finished |
| `session.error` | `error` | An error occurred |
| `permission.asked` | `permission` | Tool needs approval |
| `question.asked` | `question` | Agent is asking a question |

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

Both commands bundle the plugin into a single `.js` file and copy it to `~/.config/opencode/plugin/superwhisper.js`. OpenCode picks it up on next session.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPERWHISPER_DEBUG` | unset | Set to `1` to enable debug logging (outputs to OpenCode's log) |

### Project Structure

```
src/
  index.ts        # Plugin entry point and event handlers
  types.ts        # Types, interfaces, constants
  deeplink.ts     # Deeplink URL building
  message.ts      # Message extraction and summary
  poll.ts         # Response file polling
  normalize.ts    # Question/permission response normalization
  index.test.ts   # Tests
```

## License

MIT
