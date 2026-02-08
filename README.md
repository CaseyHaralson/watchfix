# watchfix

CLI tool that watches logs, detects errors, and dispatches AI agents to fix them.

## Features

- **Log watching**: Monitor file logs, command output, or Docker container logs
- **Error detection**: Configurable patterns to identify errors in your logs
- **AI-powered fixes**: Automatically dispatch Claude, Gemini, or Codex to analyze and fix errors
- **Context awareness**: Generates relevant context files for AI agents
- **Deduplication**: Groups similar errors to avoid redundant fixes
- **Daemon mode**: Run in the background on Linux/macOS

## Installation

```bash
npm install -g watchfix
```

## Requirements

- Node.js 18+
- One of the following AI CLI tools:
  - [Claude CLI](https://github.com/anthropics/claude-code)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli)
  - [Codex CLI](https://github.com/openai/codex)

## Quick Start

1. Initialize a configuration file in your project:

```bash
watchfix init
```

2. Edit `watchfix.yaml` to configure your log sources and error patterns:

```yaml
version: "1"

sources:
  - name: app
    type: file
    path: ./logs/app.log

patterns:
  - name: node-error
    regex: "Error: .+"
    severity: error

agent:
  provider: claude
```

3. Start watching logs:

```bash
watchfix watch
```

4. When an error is detected, fix it:

```bash
watchfix fix <error-id>
```

## Autonomous Mode

For fully automated error fixing without manual approval:

```bash
watchfix watch --autonomous
```

In autonomous mode, watchfix automatically dispatches AI agents to fix detected errors. Combine with daemon mode for background operation (Linux/macOS):

```bash
watchfix watch --daemon --autonomous
```

**Note:** Manual `watchfix fix` commands are blocked while running in autonomous mode.

## CLI Commands

| Command | Description |
|---------|-------------|
| `watchfix init` | Create `watchfix.yaml` in current directory |
| `watchfix watch` | Watch logs in foreground (use `--daemon` for background, `--autonomous` for auto-fix) |
| `watchfix fix [id]` | Analyze and fix a specific error (or `--all` for all pending) |
| `watchfix show <id>` | Show full error details and analysis |
| `watchfix status` | Show watcher state and pending errors |
| `watchfix stop` | Stop background watcher |
| `watchfix ignore <id>` | Mark error as ignored |
| `watchfix logs` | Show activity log |
| `watchfix clean` | Remove old context files |
| `watchfix config validate` | Validate configuration file |
| `watchfix manual` | Show detailed reference documentation (for AI agents and advanced users) |

### Global Options

- `-c, --config <path>`: Use alternate config file
- `--verbose`: Increase output verbosity
- `-q, --quiet`: Suppress non-essential output

## Platform Notes

- **Daemon mode** (`watchfix watch --daemon`) is only available on Linux and macOS
- Windows users should run `watchfix watch` in a terminal window or use a process manager

## Documentation

Run `watchfix manual` for a detailed CLI reference covering all commands, flags, exit codes, error statuses, JSON output format, and common workflows.

For detailed configuration options and advanced usage, see the [specification document](./spec/watchfix-spec-v8.md).

For a working example project, see [watchfix-example](https://github.com/CaseyHaralson/watchfix-example).

## License

[MIT](./LICENSE)
