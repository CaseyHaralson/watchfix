# watchfix - Agent Reference

> Run `watchfix manual` to display this document.

## Quick Context

watchfix is a CLI tool that watches log files, detects errors via configurable patterns, and dispatches AI agents (Claude, Gemini, or Codex) to analyze and fix them automatically. Prerequisites: a `watchfix.yaml` config file in your project root, one of the supported AI CLIs installed and in PATH, and at least one log source configured. All state is stored locally in `.watchfix/errors.db` (SQLite).

## Commands

### Setup Commands

#### `watchfix init`

Create a `watchfix.yaml` config file in the current directory.

```
watchfix init [--agent <provider>] [--force]
```

| Flag | Description |
|------|-------------|
| `--agent <provider>` | Set agent provider: `claude`, `gemini`, or `codex` (default: `claude`) |
| `--force` | Overwrite existing `watchfix.yaml` |

Output: writes `watchfix.yaml` and adds `.watchfix/` to `.gitignore`.

#### `watchfix config validate`

Validate the configuration file.

```
watchfix config validate [-c <path>]
```

Exit code 0 if valid, 1 if invalid (error message on stderr).

### Watching Commands

#### `watchfix watch`

Start watching configured log sources for errors.

```
watchfix watch [--daemon] [--autonomous]
```

| Flags | Mode | Behavior |
|-------|------|----------|
| _(none)_ | Foreground, manual | Detects errors, queues for manual `fix` |
| `--autonomous` | Foreground, autonomous | Detects and auto-fixes without approval |
| `--daemon` | Background, manual | Runs detached; logs to activity log only |
| `--daemon --autonomous` | Background, autonomous | Runs detached; auto-fixes in background |

Exit code 2 if a watcher is already running.

#### `watchfix stop`

Stop a running background watcher.

```
watchfix stop
```

Exit code 2 if no watcher is running.

#### `watchfix status`

Show watcher state and pending errors.

```
watchfix status
```

Output format (plain text, one error per line):

```
Watcher: running (pid 12345, mode: autonomous)
Uptime: 2h 15m

Errors:
  #1  [pending]    TypeError: Cannot read property 'x' of null  (app)
  #3  [suggested]  ReferenceError: foo is not defined  (api)
  #7  [fixing]     FATAL: connection refused  (db)
```

When no errors exist: `No errors recorded.`
When watcher is not running: `Watcher: not running`

### Error Management Commands

#### `watchfix show <id>`

Show full error details and analysis.

```
watchfix show <id> [--json]
```

| Flag | Description |
|------|-------------|
| `--json` | Output machine-readable JSON (see JSON Output Format below) |

Without `--json`, outputs human-readable text with error metadata, stack trace, analysis, fix result, and activity log.

#### `watchfix fix [id]`

Analyze and fix an error. Without an id, requires `--all`.

```
watchfix fix <id> [-y] [--analyze-only] [--reanalyze]
watchfix fix --all [--confirm-each] [--analyze-only] [--reanalyze]
```

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip confirmation prompt |
| `--all` | Fix all pending/suggested errors sequentially |
| `--confirm-each` | With `--all`: prompt before each fix |
| `--analyze-only` | Stop after analysis, don't apply the fix |
| `--reanalyze` | Force re-analysis even if already in `suggested` status |

Exit code 3 if the error is not in an actionable status or not found.

#### `watchfix ignore <id>`

Mark an error as ignored. It will not be processed further.

```
watchfix ignore <id>
```

### Utility Commands

#### `watchfix logs`

Show the activity log.

```
watchfix logs [--tail] [-n <count>]
```

| Flag | Description |
|------|-------------|
| `--tail` | Follow the log (stream new entries) |
| `-n, --lines <count>` | Number of lines to show (default: 50) |

#### `watchfix clean`

Remove old context files from `.watchfix/context/`.

```
watchfix clean [--dry-run] [--force]
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would be removed without deleting |
| `--force` | Skip confirmation prompt |

#### `watchfix version`

Show version, Node.js version, config status, and agent provider.

```
watchfix version
```

#### `watchfix manual`

Output this reference document to stdout.

```
watchfix manual
```

### Global Options

These flags work with all commands:

| Flag | Description |
|------|-------------|
| `-c, --config <path>` | Use alternate config file (default: `./watchfix.yaml`) |
| `--verbose` | Increase output verbosity |
| `-q, --quiet` | Suppress non-essential output |
| `-h, --help` | Show help for command |
| `-v, --version` | Show version and exit |

## Common Workflows

### Check if watchfix is set up

```bash
# Look for config file
ls watchfix.yaml

# Validate it
watchfix config validate
```

### Start watching and monitor

```bash
# Start watcher in foreground
watchfix watch

# Or in background (Linux/macOS)
watchfix watch --daemon

# Poll for errors
watchfix status

# Stream activity log
watchfix logs --tail
```

### Investigate and fix one error

```bash
# See what errors exist
watchfix status

# Get full details (machine-readable)
watchfix show 3 --json

# Fix it (with confirmation)
watchfix fix 3

# Or skip confirmation
watchfix fix 3 -y
```

### Fix all pending errors

```bash
watchfix fix --all
```

### Fully automated operation

```bash
# Start autonomous daemon
watchfix watch --daemon --autonomous

# Monitor progress
watchfix status
watchfix logs --tail

# Stop when done
watchfix stop
```

### Analyze without fixing

```bash
# Get analysis only (no code changes)
watchfix fix 3 --analyze-only

# View the analysis
watchfix show 3
```

## Exit Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `SUCCESS` | Command completed successfully |
| 1 | `GENERAL_ERROR` | General error (invalid config, agent failure, etc.) |
| 2 | `WATCHER_CONFLICT` | Watcher state conflict (already running / not running) |
| 3 | `NOT_ACTIONABLE` | Target not actionable (error not found, wrong status, locked) |
| 4 | `SCHEMA_MISMATCH` | Database schema version mismatch (requires migration) |
| 130 | `INTERRUPTED` | Interrupted by user (SIGINT / Ctrl+C) |

## Error Statuses

### Status Lifecycle

```
pending → analyzing → suggested → fixing → fixed
                                         → failed (after max attempts)
Any status → ignored (via watchfix ignore)
```

### Status Reference

| Status | Description | Actionable? |
|--------|-------------|-------------|
| `pending` | Detected, awaiting analysis | Yes — `fix` will start analysis |
| `analyzing` | Agent is currently analyzing | No — locked |
| `suggested` | Analysis complete, awaiting fix | Yes — `fix` will apply the suggestion |
| `fixing` | Agent is currently applying fix | No — locked |
| `fixed` | Fix applied and verified | No — terminal |
| `failed` | Max attempts exceeded | Manual retry only (`fix <id>`, excluded from `--all`) |
| `ignored` | User chose to ignore | No — terminal |
| `resolved` | Fixed by a previous fix to another error | No — terminal |
| `deferred` | Non-code issue (infrastructure/config) | No — shows remediation guidance |

### Deduplication

When a new error matches an existing one (by hash):
- If existing is `pending`, `analyzing`, `suggested`, or `fixing`: new error is dropped
- If existing is `fixed`, `failed`, or `ignored`: a new entry is created (error recurred)

## JSON Output Format

`watchfix show <id> --json` returns a JSON object with this shape:

```json
{
  "error": {
    "id": 1,
    "hash": "abc123...",
    "source": "app",
    "timestamp": "2026-01-29T12:00:00.000Z",
    "errorType": "TypeError",
    "message": "Cannot read property 'x' of null",
    "stackTrace": "TypeError: Cannot read property...\n    at foo (src/app.ts:10:5)\n    ...",
    "rawLog": "[2026-01-29 12:00:00] ERROR TypeError: Cannot read property...",
    "status": "suggested",
    "suggestion": "{\"summary\":\"...\",\"root_cause\":\"...\",\"suggested_fix\":\"...\"}",
    "fixResult": null,
    "fixAttempts": 0,
    "lockedBy": null,
    "lockedAt": null,
    "createdAt": "2026-01-29T12:00:01.000Z",
    "updatedAt": "2026-01-29T12:00:05.000Z"
  },
  "analysis": {
    "summary": "Null pointer access in foo()",
    "root_cause": "Variable 'x' is not initialized before access",
    "suggested_fix": "Add null check before accessing property",
    "files_to_modify": ["src/app.ts"],
    "confidence": "high",
    "category": "code"
  },
  "fixResult": null,
  "activityLog": [
    {
      "id": 1,
      "timestamp": "2026-01-29T12:00:01.000Z",
      "action": "error_detected",
      "error_id": 1,
      "details": "TypeError: Cannot read property 'x' of null"
    }
  ]
}
```

### Key Fields

- `error.status` — current lifecycle status (see Error Statuses above)
- `error.suggestion` — raw JSON string of agent analysis (parse it to get the `analysis` object)
- `error.fixResult` — raw JSON string of fix result (null if not yet fixed)
- `analysis` — parsed suggestion object; `null` if not yet analyzed
  - `analysis.category` — `"code"`, `"infrastructure"`, or `"configuration"`
  - `analysis.confidence` — `"high"`, `"medium"`, or `"low"`
  - `analysis.remediation_guidance` — present for `deferred` (non-code) errors
- `fixResult` — parsed fix result object; `null` if not yet fixed
  - `fixResult.success` — boolean indicating if verification passed
  - `fixResult.files_changed` — array of `{ "path": "...", "change": "..." }`
- `activityLog` — chronological list of actions taken on this error

## Configuration Quick Reference

watchfix uses a `watchfix.yaml` file in the project root. Run `watchfix init` to generate a template.

### Key Sections

```yaml
project:
  name: my-app          # Project identifier
  root: .               # Project root (paths resolve relative to this)

agent:
  provider: claude       # Required: claude | gemini | codex
  timeout: 5m            # Max agent execution time (default: 5m)
  retries: 2             # Retries on agent timeout/crash (default: 2)

logs:
  sources:               # At least one source required
    - name: app          # Source identifier
      type: file         # file | docker | command
      path: ./logs/app.log
  context_lines_before: 10
  context_lines_after: 5

verification:
  test_commands:         # Run after fix, in order; stop on first failure
    - npm run lint
    - npm test
  health_checks:         # HTTP GET, expect 2xx
    - http://localhost:3000/health

patterns:
  match:                 # Additional error patterns
    - "FATAL:"
    - "regex:OOM.*killed"
  ignore:                # Patterns to skip
    - "DeprecationWarning"

limits:
  max_attempts_per_error: 3

cleanup:
  context_max_age_days: 7
```

### Source Types

| Type | Required Fields | Description |
|------|----------------|-------------|
| `file` | `path` | Watch a log file (supports `format: ndjson` for structured JSON logs) |
| `docker` | `container` | Watch Docker container logs |
| `command` | `run`, `interval` | Run a command periodically and scan output |

For full configuration details and NDJSON options, run `watchfix init` to see the annotated template.
