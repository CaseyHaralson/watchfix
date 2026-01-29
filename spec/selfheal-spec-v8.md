# selfheal v8 Specification

A TypeScript CLI tool that watches project logs, detects errors, and uses AI coding agents to analyze and fix them. Agent-agnostic: supports Claude Code, Gemini CLI, and OpenAI Codex.

---

## Table of Contents

1. [Overview](#overview)
2. [CLI Commands](#cli-commands)
3. [Configuration](#configuration)
4. [Agent System](#agent-system)
5. [Log Watching](#log-watching)
6. [Error Detection](#error-detection)
7. [Fix Pipeline](#fix-pipeline)
8. [Verification](#verification)
9. [Storage](#storage)
10. [Concurrency and Locking](#concurrency-and-locking)
11. [Daemon Management](#daemon-management)
12. [Logging](#logging)
13. [Project Structure](#project-structure)
14. [Testing Strategy](#testing-strategy)
15. [Error Handling](#error-handling)
16. [Example Workflows](#example-workflows)

---

## Overview

selfheal monitors application logs, detects errors using pattern matching, and dispatches them to an AI coding agent for analysis and automated fixes. It operates in two modes:

- **Manual mode**: Errors queue for human review; fixes require explicit approval
- **Autonomous mode**: Errors are automatically analyzed and fixed without intervention

### Requirements

- Node.js 18+
- One of: Claude Code CLI, Gemini CLI, or OpenAI Codex CLI
- Project with accessible logs (file, Docker, or command output)

### Platform Support

- **Linux/macOS**: Full support including daemon mode
- **Windows**: Full support except daemon mode (`--daemon` flag is unsupported; use foreground mode)

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `selfheal init` | Create `selfheal.yaml` in current directory |
| `selfheal watch` | Watch logs in foreground |
| `selfheal watch --daemon` | Watch logs in background (Linux/macOS only) |
| `selfheal watch --autonomous` | Auto-fix errors without approval |
| `selfheal stop` | Stop background watcher |
| `selfheal status` | Show watcher state and pending errors |
| `selfheal show <id>` | Show full error details and analysis |
| `selfheal fix <id>` | Analyze and fix specific error |
| `selfheal fix --all` | Fix all pending/suggested errors (sequentially) |
| `selfheal ignore <id>` | Mark error as ignored |
| `selfheal logs` | Show activity log |
| `selfheal logs --tail` | Follow activity log |
| `selfheal config validate` | Validate configuration file |
| `selfheal clean` | Remove old context files |
| `selfheal version` | Show version information |

### Global Flags

| Flag | Description |
|------|-------------|
| `--config`, `-c <path>` | Use alternate config file (default: `./selfheal.yaml`) |
| `--verbose` | Increase output verbosity |
| `--quiet`, `-q` | Suppress non-essential output |
| `--version`, `-v` | Show version and exit |
| `--help`, `-h` | Show help for command |

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error (config invalid, agent failed, etc.) |
| 2 | Watcher state conflict (already running / not running) |
| 3 | Target not actionable (error not found, wrong status, locked) |
| 4 | Database schema mismatch (requires migration) |
| 130 | Interrupted by user (SIGINT) |

### Command Details

#### `selfheal init`

Creates `selfheal.yaml` with a commented template:
- Sets `project.name` to the current directory name
- Sets `agent.provider` to `claude` (most common)
- Includes example log source configurations (commented out)
- Appends `.selfheal/` to `.gitignore` if not already present (creates file if needed)

The generated file includes comments explaining each option. Users edit the file to configure their specific log sources and agent provider.

Flags:
- `--agent <provider>`: Set initial agent provider (claude, gemini, codex)
- `--force`: Overwrite existing `selfheal.yaml`

#### `selfheal watch`

Starts watching configured log sources. Behavior:

| Flag | Behavior |
|------|----------|
| (none) | Foreground, manual mode. Outputs to terminal and log file. |
| `--daemon` | Background, manual mode. Outputs to log file only. (Linux/macOS only) |
| `--autonomous` | Foreground, autonomous mode. Auto-fixes without approval. |
| `--daemon --autonomous` | Background, autonomous mode. (Linux/macOS only) |

On Windows, `--daemon` exits with an error message directing users to use foreground mode or a process manager like PM2.

> **Note:** The daemon reads configuration once at startup. To apply config changes, run `selfheal stop` and restart with `selfheal watch`.

#### `selfheal fix <id>`

1. Checks if daemon is running in autonomous mode (blocks with error if so)
2. Validates error exists and is in fixable state (`pending`, `suggested`, or `failed`)
3. Acquires lock on error (fails if already being processed)
4. Runs analysis phase if status is `pending` (or if `--reanalyze` flag is set). If status is already `suggested`, skips to step 5.
5. Displays analysis summary and asks for confirmation (unless `--yes`)
6. Runs fix phase
7. Runs verification
8. Reports result

Flags:
- `--yes`, `-y`: Skip confirmation prompt
- `--analyze-only`: Stop after analysis, don't apply fix. When `--analyze-only` is used, the `--yes` flag has no effect since there is no fix to confirm.
- `--reanalyze`: Force re-run analysis even if already in `suggested` status

**Re-analysis Failure Handling:** When `--reanalyze` is used and the new analysis fails:
- The existing `suggestion` data is preserved (not cleared)
- The error remains in `suggested` status
- The failure is logged but does not count against `fix_attempts`
- User can retry with `--reanalyze` or proceed with the existing analysis using `fix <id>` without the flag

When `--analyze-only` is used, the error is left in `suggested` status after analysis completes, and the lock is released. A subsequent `selfheal fix <id>` will skip analysis and proceed directly to the fix phase.

**Attempt Number Handling:** When fixing a `suggested` error (skipping analysis), the result file uses the current `fix_attempts` value as the attempt number. The analysis is read from the `suggestion` column in the database (stored as JSON from the previous analysis phase) and embedded in the fix context file under "Previous Analysis".

**Interrupt Handling:** For interactive commands (`fix`, `fix --all`), SIGINT cancels the current operation. If an agent is running, it receives SIGTERM. The error remains in its current status (`analyzing` or `fixing`) and the lock is released. On next attempt, stale recovery will reset it to `pending`.

#### `selfheal fix --all`

Fixes all `pending` and `suggested` errors sequentially:
- Checks if daemon is running in autonomous mode (blocks with error if so, same as `fix <id>`)
- Implies `--yes` (no per-error confirmation prompts)
- Does NOT stop on failure (continues to next error)
- Skips errors that fail to acquire lock (being processed elsewhere)
- Skips errors in `analyzing` or `fixing` status
- Each error follows the same fix logic as `selfheal fix <id>`
- Reports summary at end showing: fixed count, failed count, skipped count

Flags:
- `--confirm-each`: Prompt for confirmation before each fix (overrides implicit `--yes`)
- `--analyze-only`: Analyze all pending errors without applying fixes
- `--reanalyze`: Force re-run analysis for all errors, even those already in `suggested` status

> **Note:** `fix --all` excludes `failed` errors intentionally. Failed errors have exceeded max attempts and should be reviewed individually with `selfheal show <id>` before retrying.

**Interrupt Handling:** SIGINT during `fix --all` cancels the current error's operation (same as `fix <id>`) and exits immediately without processing remaining errors. The interrupted error follows normal stale recovery on next run. The process exits with code 130 (standard SIGINT exit code).

#### `selfheal show <id>`

Displays full details for an error:
- Error metadata: id, type, source, timestamp, status, fix_attempts
- Full message and stack trace
- Raw log context
- Analysis (if exists): summary, root cause, suggested fix, confidence
- Fix result (if exists): success, files changed, notes
- Activity log entries for this error

Flags:
- `--json`: Output as JSON (for scripting)

#### `selfheal ignore <id>`

Marks an error as ignored:
1. Validates error exists and is in ignorable state (`pending`, `suggested`, or `failed`)
2. Acquires lock (fails if locked by another process)
3. Sets status to `ignored`
4. Releases lock

Ignored errors are not processed by autonomous mode and don't appear in `selfheal status` actionable list.

#### `selfheal config validate`

Validates `selfheal.yaml` without starting the watcher:
- Checks YAML syntax
- Validates against schema
- Validates agent CLI is installed (reports version)
- Checks log source paths are accessible (warning if not, will wait for creation)
- Validates duration strings are parseable
- Reports all issues found

```bash
$ selfheal config validate
✓ Config syntax valid
✓ Agent CLI found: claude (v1.2.3)
⚠ Log source 'backend': file does not exist (will wait for creation)
✓ Config valid
```

#### `selfheal clean`

Removes old context files based on `cleanup.context_max_age_days` config:

```bash
$ selfheal clean
Removing context files older than 7 days...
Removed 23 files (1.2 MB)
```

Flags:
- `--dry-run`: Show what would be removed without deleting
- `--force`: Skip confirmation prompt

**Safety:** Context files for errors currently in `analyzing` or `fixing` status are never deleted, regardless of age.

#### `selfheal logs`

Shows activity log entries.

Flags:
- `--tail`, `-f`: Follow log (stream new entries)
- `--lines`, `-n <count>`: Number of lines to show (default: 50)

```bash
$ selfheal logs -n 20
$ selfheal logs --tail
```

Output format matches `daemon.log` exactly:
```
{ISO8601 timestamp} [{LEVEL}] {message}
```

When `--tail` is used, new entries are streamed as they are written to the log file.

#### `selfheal version`

Shows version and environment information. This command works without a config file.

```bash
# With valid config:
$ selfheal version
selfheal v1.0.0
Node.js v20.10.0
Agent: claude (Claude Code v1.2.3)
Config: selfheal.yaml (valid)

# Without config:
$ selfheal version
selfheal v1.0.0
Node.js v20.10.0
Config: not found
```

If a config file exists but is invalid, show the validation errors.

---

## Configuration

### Path Resolution

All relative paths in `selfheal.yaml` are resolved relative to the directory containing the config file. When using `--config` to specify an alternate location, paths are still relative to that config file's directory, not the current working directory.

### Duration Strings

Duration values use a simple format with supported units:
- `s` - seconds (e.g., `30s`)
- `m` - minutes (e.g., `5m`)
- `h` - hours (e.g., `1h`)

Examples: `5s`, `10m`, `1h`, `90s`

### Complete Schema

```yaml
# selfheal.yaml

project:
  name: my-app                    # Project identifier (used in logs)
  root: .                         # Project root (paths relative to this)

agent:
  provider: claude                # Required: claude | gemini | codex
  timeout: 5m                     # Max time for agent execution (default: 5m)
  retries: 2                      # Retries on agent timeout/crash (default: 2)
  # Optional overrides (defaults provided per provider):
  # command: claude
  # args: ["--model", "sonnet", "--dangerously-skip-permissions", "-p"]
  # stderr_is_progress: false     # If true, stderr is progress info not errors

logs:
  sources:
    - name: backend               # Identifier for this source
      type: file                  # file | docker | command
      path: ./logs/backend.log    # For type: file

    - name: api
      type: docker
      container: my-app-api       # For type: docker

    - name: compose
      type: command
      run: docker-compose logs --tail=100   # For type: command
      interval: 30s               # Required for type: command

  # Error context configuration
  context_lines_before: 10        # Lines before error (default: 10)
  context_lines_after: 5          # Lines after stack trace (default: 5)
  max_line_buffer: 10000          # Max lines to buffer per source (default: 10000)

verification:
  test_commands:                  # Run in order, stop on first failure
    - npm run lint
    - npm test
    - npm run e2e
  test_command_timeout: 5m        # Timeout per test command (default: 5m)
  health_checks:                  # HTTP GET, expect 2xx
    - http://localhost:3000/health
    - http://localhost:3001/api/status
  health_check_timeout: 10s       # Timeout per health check (default: 10s)
  wait_after_fix: 5s              # Wait before running verification (default: 5s)

limits:
  max_attempts_per_error: 3       # Stop retrying after N failures (default: 3)

cleanup:
  context_max_age_days: 7         # Delete context files older than this (default: 7)
  context_max_size_kb: 256        # Max context file size in KB (default: 256)

patterns:
  match:                          # Additional patterns to treat as errors
    - "FATAL:"                    # Plain string (case-insensitive substring)
    - "panic:"
    - "Segmentation fault"
    - "regex:OOM.*killed"         # Regex pattern (prefix with regex:)
  ignore:                         # Patterns to skip (won't create errors)
    - "DeprecationWarning"
    - "ExperimentalWarning"
    - "regex:retry attempt \\d+"  # Regex with escaped backslash
    - "graceful shutdown"
```

### Zod Schema

```typescript
import { z } from 'zod';

const durationSchema = z.string()
  .regex(
    /^\d+[smh]$/,
    'Duration must be a number followed by s, m, or h (e.g., "5m", "30s", "1h")'
  )
  .refine((val) => {
    const num = parseInt(val.slice(0, -1), 10);
    return num > 0;
  }, 'Duration must be greater than 0')
  .refine((val) => {
    const num = parseInt(val.slice(0, -1), 10);
    const unit = val.slice(-1);
    const ms = num * { s: 1000, m: 60000, h: 3600000 }[unit]!;
    return ms <= 24 * 60 * 60 * 1000; // Max 24 hours
  }, 'Duration cannot exceed 24 hours');

const fileSourceSchema = z.object({
  name: z.string().min(1),
  type: z.literal('file'),
  path: z.string().min(1),
});

const dockerSourceSchema = z.object({
  name: z.string().min(1),
  type: z.literal('docker'),
  container: z.string().min(1),
});

const commandSourceSchema = z.object({
  name: z.string().min(1),
  type: z.literal('command'),
  run: z.string().min(1),
  interval: durationSchema,
});

const logSourceSchema = z.discriminatedUnion('type', [
  fileSourceSchema,
  dockerSourceSchema,
  commandSourceSchema,
]);

const patternSchema = z.string().min(1);

const configSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    root: z.string().default('.'),
  }),

  agent: z.object({
    provider: z.enum(['claude', 'gemini', 'codex']),
    timeout: durationSchema.default('5m'),
    retries: z.number().int().min(0).default(2),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    stderr_is_progress: z.boolean().optional(),
  }),

  logs: z.object({
    sources: z.array(logSourceSchema).min(1).refine(
      (sources) => {
        const names = sources.map(s => s.name);
        return names.length === new Set(names).size;
      },
      { message: 'Log source names must be unique' }
    ),
    context_lines_before: z.number().int().min(0).default(10),
    context_lines_after: z.number().int().min(0).default(5),
    max_line_buffer: z.number().int().min(100).default(10000),
  }),

  verification: z.object({
    test_commands: z.array(z.string()).default([]),
    test_command_timeout: durationSchema.default('5m'),
    health_checks: z.array(
      z.string().url().refine(
        (url) => url.startsWith('http://') || url.startsWith('https://'),
        { message: 'Health check URL must use http:// or https://' }
      )
    ).default([]),
    health_check_timeout: durationSchema.default('10s'),
    wait_after_fix: durationSchema.default('5s'),
  }).default({}),

  limits: z.object({
    max_attempts_per_error: z.number().int().min(1).default(3),
  }).default({}),

  cleanup: z.object({
    context_max_age_days: z.number().int().min(1).default(7),
    context_max_size_kb: z.number().int().min(64).default(256),
  }).default({}),

  patterns: z.object({
    match: z.array(patternSchema).default([]),
    ignore: z.array(patternSchema).default([]),
  }).default({}),
});

export type Config = z.infer<typeof configSchema>;
export { configSchema };
```

### Validation

Configuration is validated using Zod on load. Validation includes:

- Required fields present
- Log source configs match their type
- `interval` required for `command` type sources
- Agent provider is one of: `claude`, `gemini`, `codex`
- Duration strings are parseable
- Numeric values are positive integers where required
- Paths are accessible (warning if not, will wait for creation)
- Validate `project.root` resolves to an existing directory (error if not found)
- Log source names are unique within the config

### Default Agent Configurations

If only `provider` is specified, these defaults are used:

```typescript
const AGENT_DEFAULTS = {
  claude: {
    command: 'claude',
    args: ['--model', 'sonnet', '--dangerously-skip-permissions', '-p'],
    stderrIsProgress: false,
  },
  gemini: {
    command: 'gemini',
    args: ['--yolo', '-p'],
    stderrIsProgress: true,
  },
  codex: {
    command: 'codex',
    args: ['exec', '--yolo'],
    stderrIsProgress: true,
  },
};

const AGENT_CONFIG_DEFAULTS = {
  timeout: 5 * 60 * 1000, // 5 minutes in ms
  retries: 2,
};
```

If `command` or `args` are specified in config, they override the defaults entirely (not merged).

**Note:** These defaults reflect CLI invocations at time of specification. If an agent CLI changes its argument handling, override `command` and `args` in the config file.

---

## Agent System

### Interface

```typescript
interface AgentConfig {
  provider: 'claude' | 'gemini' | 'codex';
  command: string;
  args: string[];             // Args before the prompt
  stderrIsProgress: boolean;
  timeout: number;            // Milliseconds
  retries: number;            // Max retry attempts on failure
}

interface AgentResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  outputFileExists: boolean;  // Whether expected output file was created
}

interface Agent {
  config: AgentConfig;
  analyze(contextPath: string): Promise<AgentResult>;
  fix(contextPath: string): Promise<AgentResult>;
}
```

### Execution Model

The agent args array contains everything *before* the prompt. At execution time, the prompt is appended as the final argument:

```typescript
function buildCommand(config: AgentConfig, prompt: string): [string, string[]] {
  return [config.command, [...config.args, prompt]];
}

// Example for Claude:
// command: "claude"
// args: ["--model", "sonnet", "--dangerously-skip-permissions", "-p"]
// prompt: "Read .selfheal/context/2025-01-27-error-1-attempt-0.md and follow the instructions."
// Result: claude --model sonnet --dangerously-skip-permissions -p "Read .selfheal/context/..."
```

**Working Directory:** The agent process is spawned with `cwd` set to the project root (resolved from `project.root` in config). All paths in context files are relative to this directory.

### Prompt Templates

The prompts passed to agents are:

```typescript
const PROMPTS = {
  analyze: (contextPath: string) =>
    `Read ${contextPath} and follow the instructions.`,
  fix: (contextPath: string) =>
    `Read ${contextPath} and follow the instructions.`,
};

// Example contextPath values:
// - Analysis: .selfheal/context/2025-01-27-error-1-attempt-0-analyze.md
// - Fix: .selfheal/context/2025-01-27-error-1-attempt-0-fix.md
```

The context file contains all necessary details including mode, error information, and output file path.

### Progress Handling

Some agents (Gemini, Codex) write progress to stderr and final output to stdout. The `stderrIsProgress` flag controls how output is handled:

- `stderrIsProgress: false` — stderr indicates problems; captured and logged as warnings
- `stderrIsProgress: true` — stderr is progress info; streamed to terminal in foreground mode, captured but not logged as warnings (still available in `AgentResult.stderr` for debugging)

### Timeout and Retry Handling

Agent execution has a configurable timeout (default: 5 minutes) and retry count (default: 2):

```typescript
async function executeAgent(
  config: AgentConfig,
  prompt: string,
  expectedOutputFile: string,
  cwd: string
): Promise<AgentResult> {
  let lastResult: AgentResult | null = null;
  
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    if (attempt > 0) {
      logger.warn(`Agent attempt ${attempt + 1}/${config.retries + 1}...`);
    }
    
    const result = await spawnAgentWithTimeout(config, prompt, cwd);
    
    // Check if output file was created
    result.outputFileExists = await fileExists(expectedOutputFile);
    
    if (result.success && result.outputFileExists) {
      return result;
    }
    
    lastResult = result;
    
    if (!result.outputFileExists && !result.timedOut) {
      logger.warn(`Agent did not create expected output file: ${expectedOutputFile}`);
    }
  }
  
  // All retries exhausted
  return lastResult ?? {
    success: false,
    stdout: '',
    stderr: 'All retries exhausted',
    exitCode: -1,
    timedOut: false,
    outputFileExists: false,
  };
}

async function spawnAgentWithTimeout(
  config: AgentConfig,
  prompt: string,
  cwd: string
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const child = spawn(config.command, [...config.args, prompt], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    
    let stdout = '';
    let stderr = '';
    let killed = false;
    
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    
    // Set up timeout
    const timeoutId = setTimeout(() => {
      killed = true;
      logger.warn(`Agent timed out after ${config.timeout}ms, sending SIGTERM`);
      child.kill('SIGTERM');
      
      // Force kill if still running after 5s
      setTimeout(() => {
        if (!child.killed) {
          logger.warn('Agent did not respond to SIGTERM, sending SIGKILL');
          child.kill('SIGKILL');
        }
      }, 5000);
    }, config.timeout);
    
    child.on('close', (code) => {
      clearTimeout(timeoutId);
      resolve({
        success: code === 0 && !killed,
        stdout,
        stderr,
        exitCode: code ?? -1,
        timedOut: killed,
        outputFileExists: false, // Set by caller
      });
    });
    
    child.on('error', (err) => {
      clearTimeout(timeoutId);
      resolve({
        success: false,
        stdout,
        stderr: err.message,
        exitCode: -1,
        timedOut: false,
        outputFileExists: false,
      });
    });
  });
}
```

On timeout:
- The agent process is killed (SIGTERM, then SIGKILL after 5s)
- Retry is attempted if under retry limit
- Activity log records the timeout with attempt number

### Output File Validation

After agent execution, the system checks for the expected output file:

1. **File exists**: Parse and validate contents
2. **File missing**: Treat as failure, store agent stdout/stderr as diagnostic info

```typescript
async function processAgentResult(
  result: AgentResult,
  expectedOutputFile: string,
  errorId: number,
  phase: 'analysis' | 'fix'
): Promise<{ success: boolean; data: any; diagnostic: string }> {
  if (!result.outputFileExists) {
    // Agent didn't create output file - store stdout/stderr for debugging
    const diagnostic = [
      `Agent did not create ${expectedOutputFile}`,
      `Exit code: ${result.exitCode}`,
      result.timedOut ? 'Agent timed out' : '',
      result.stdout ? `stdout:\n${result.stdout}` : '',
      result.stderr ? `stderr:\n${result.stderr}` : '',
    ].filter(Boolean).join('\n');
    
    return { success: false, data: null, diagnostic };
  }
  
  // File exists, try to parse
  try {
    const content = await readFile(expectedOutputFile, 'utf8');
    const data = parseYaml(content);
    
    // Validate required fields based on phase
    if (phase === 'analysis') {
      validateAnalysisOutput(data); // throws if invalid
    } else {
      validateFixOutput(data); // throws if invalid
    }
    
    return { success: true, data, diagnostic: '' };
  } catch (err) {
    // Parse or validation failed - store raw content
    const rawContent = await readFile(expectedOutputFile, 'utf8').catch(() => '');
    return {
      success: false,
      data: null,
      diagnostic: `Failed to parse output: ${err.message}\nRaw content:\n${rawContent}`,
    };
  }
}

// After successful analysis, transition status and store result
async function handleAnalysisSuccess(
  errorId: number,
  lockId: string,
  analysisData: AnalysisOutput
): Promise<void> {
  const success = await transitionStatus(errorId, 'analyzing', 'suggested', lockId);
  if (success) {
    db.run(
      'UPDATE errors SET suggestion = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(analysisData), new Date().toISOString(), errorId]
    );
    logActivity('analysis_complete', errorId, { confidence: analysisData.confidence });
  }
}
```

**Partial Modification Risk:** If the agent modifies project files but fails to produce output (crash, timeout, etc.), those modifications persist. The next retry will re-analyze the modified codebase. For critical systems, users should commit or stash changes before fixes, or run fixes in a separate branch. Consider adding this warning to the context file's Constraints section.

### CLI Validation

On `selfheal init` or first `selfheal watch`, validate the agent CLI exists:

```typescript
interface CliCheckResult {
  exists: boolean;
  version?: string;
  error?: string;
}

function checkCliExists(command: string): CliCheckResult {
  try {
    const result = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      shell: process.platform === 'win32',
    });
    
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { exists: false, error: `'${command}' not found in PATH` };
      }
      return { exists: false, error: result.error.message };
    }
    
    const version = result.stdout.trim().split('\n')[0];
    return { exists: true, version };
  } catch (err) {
    return { exists: false, error: err.message };
  }
}
```

Fail fast with clear installation instructions if CLI not found.

---

## Log Watching

### Source Types

#### File Source

Watches a file for appended content using `chokidar`. Handles:
- File rotation (detects truncation, re-reads from start)
- File not existing at start (waits for creation, logs warning)
- File permission errors (logs error, continues with other sources)

```yaml
- name: backend
  type: file
  path: ./logs/backend.log
```

**File Not Found Behavior:**

When a file source doesn't exist at startup:
1. Log a warning: `"Log file not found: ./logs/backend.log - waiting for creation"`
2. Set up a watcher on the parent directory for file creation
3. Once file appears, start reading from the beginning
4. Continue watching other sources normally in the meantime

### All Sources Failure

If all configured log sources fail to initialize (file doesn't exist, container not found, command fails on first execution):
- Log an ERROR: "No log sources available"
- Continue running the watcher (sources may become available later)
- Log a warning every 60 seconds if still no sources are active
- Do NOT exit - this allows recovery when files are created or containers start

#### Docker Source

Streams logs from a running container using `docker logs -f`. Handles:
- Container restart (reconnects automatically with backoff)
- Container not running (retries with exponential backoff)

```yaml
- name: api
  type: docker
  container: my-app-api
```

**Docker Command:**

```typescript
// Full command executed:
// docker logs -f --timestamps --since={lastCheckpoint} {container}
//
// - Timestamps are parsed in RFC3339 format
// - lastCheckpoint is stored in memory, initialized to watcher start time
// - On watcher restart, logs since start time are fetched (may cause duplicates,
//   handled by deduplication)

function buildDockerCommand(container: string, since: Date): [string, string[]] {
  return ['docker', [
    'logs', '-f', '--timestamps',
    '--since', since.toISOString(),
    container
  ]];
}
```

**Initial Checkpoint:** On watcher start, `lastCheckpoint` is set to the watcher's start time. This means logs generated before the watcher started are not processed.
```

**Reconnection Behavior:**

```typescript
const DOCKER_RECONNECT = {
  initialDelay: 1000,      // 1 second
  maxDelay: 60000,         // 1 minute
  backoffMultiplier: 2,
  maxRetries: Infinity,    // Keep trying forever
};

async function watchDockerLogs(container: string): Promise<void> {
  let delay = DOCKER_RECONNECT.initialDelay;
  
  while (!shutdownRequested) {
    try {
      await streamDockerLogs(container);
      // Stream ended (container stopped), reset delay for next attempt
      delay = DOCKER_RECONNECT.initialDelay;
    } catch (err) {
      logger.warn(`Docker connection lost for ${container}: ${err.message}`);
      logger.info(`Reconnecting in ${delay}ms...`);
      await sleep(delay);
      delay = Math.min(delay * DOCKER_RECONNECT.backoffMultiplier, DOCKER_RECONNECT.maxDelay);
    }
  }
}
```

#### Command Source

Executes a command periodically and parses output. Tracks previously seen lines (by hash) to avoid duplicate error detection.

```yaml
- name: compose
  type: command
  run: docker-compose logs --tail=100
  interval: 30s
```

**Hash Retention:** Seen line hashes are stored in memory and lost on daemon restart. This may cause duplicate error detection for command sources after restart.

**Execution Overlap:** If a command takes longer than the interval to complete, the next scheduled execution waits for the current one to complete. The interval timer resets after each execution completes.

**Large Output Handling:**

Command output is limited by `logs.max_line_buffer` (default: 10000 lines). If output exceeds this:
1. Keep the most recent `max_line_buffer` lines
2. Log a warning: `"Command output truncated: kept last 10000 of 25000 lines"`

### Watcher Event Queue

All log sources emit to a single serialized event queue:

```typescript
// AsyncQueue is a simple async iterable queue - implement using:
// - Array as buffer
// - resolve() function to signal waiting consumers
// - [Symbol.asyncIterator]() that yields from buffer or waits
// Or use a library like 'p-queue' with concurrency: 1

interface LogEvent {
  source: string;
  line: string;
  timestamp: Date;
}

class WatcherOrchestrator {
  private eventQueue: AsyncQueue<LogEvent>;
  private parser: ErrorParser;
  
  constructor() {
    this.eventQueue = new AsyncQueue();
    this.parser = new ErrorParser();
    this.startEventProcessor();
  }
  
  private async startEventProcessor(): Promise<void> {
    for await (const event of this.eventQueue) {
      // Process events serially to avoid race conditions
      await this.parser.processLine(event);
    }
  }
  
  public emit(event: LogEvent): void {
    this.eventQueue.push(event);
  }
}
```

This ensures:
- Error detection is serialized (no race conditions)
- Database writes are serialized
- Deduplication works correctly

### Multi-line Buffering

Stack traces span multiple lines. The parser buffers lines and attaches continuation lines to the preceding error:

**Continuation patterns (attached to previous error):**
- Lines starting with `at ` (JS stack frames)
- Lines starting with whitespace followed by `at ` or `in `
- Lines matching `^\s+File "` (Python stack frames)
- Lines matching `^\s+\d+:\d+` (Go stack frames with line:col)
- Lines matching `^\s+\.\.\.` (truncation indicators)

Buffer flushes when:
- A new error line is detected
- A non-continuation, non-error line is detected
- 100ms passes with no new input

> **Line Length Limit:** Individual log lines exceeding 64KB are truncated with `... [truncated]` suffix. This prevents memory exhaustion from malformed logs.

### Context Window

When an error is detected, the parser captures surrounding lines for context:

- `context_lines_before`: Lines preceding the error (default: 10)
- `context_lines_after`: Lines following the **end of the stack trace** (default: 5)

Important: The "after" context starts after the stack trace ends, not after the error line. This prevents capturing stack frames as "context" and then capturing them again as part of the stack trace.

```
[captured context - 10 lines before]
ERROR: ECONNREFUSED 127.0.0.1:5432    <-- Error line
    at TCPConnectWrap.afterConnect... <-- Stack trace line 1
    at PostgresConnection.connect...  <-- Stack trace line 2 (end of stack)
[captured context - 5 lines after stack trace]
```

---

## Error Detection

### Built-in Patterns

Always active, cannot be disabled.

#### Error Patterns (trigger detection)

| Category | Patterns |
|----------|----------|
| JavaScript | `Error:`, `TypeError:`, `ReferenceError:`, `SyntaxError:`, `RangeError:`, `URIError:`, `EvalError:` |
| Node.js | `UnhandledPromiseRejection`, `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `EADDRINUSE`, `EACCES`, `EPERM` |
| Python | `Traceback (most recent call last)`, `Exception:`, `Error:`, `AssertionError:` |
| Go | `panic:`, `fatal error:`, `runtime error:` |
| Docker | `container is not running`, `unhealthy`, `OOMKilled`, `no such container`, `connection refused` |
| Database | `SQLSTATE[`, `deadlock detected`, `duplicate key`, `constraint violation` |
| Generic | `FATAL`, `CRITICAL`, `EMERGENCY` (case-insensitive, must be followed by `:` or whitespace) |

#### Ignore Patterns (suppress detection)

| Category | Patterns |
|----------|----------|
| Log levels | `DEBUG`, `TRACE`, `VERBOSE`, `INFO` (when at line start, followed by `:` or whitespace) |
| Success indicators | `successfully`, `healthy`, `passed`, `completed`, `OK` |

Ignore patterns take precedence: if both a match and ignore pattern are found, the line is ignored.

### Custom Patterns

From `selfheal.yaml`:

```yaml
patterns:
  match:
    - "circuit breaker open"      # Plain string (case-insensitive substring match)
    - "regex:timeout after \\d+s" # Regex (prefix with regex:)
  ignore:
    - "retry attempt"
    - "regex:connection reset.*transient"
```

Pattern format:
- **Plain string**: Case-insensitive substring match
- **Regex**: Prefix with `regex:`, uses JavaScript regex syntax, case-insensitive by default

### Error Type Extraction

Extract error type from message for display and deduplication:

```typescript
function extractErrorType(message: string): string {
  const patterns: Array<[RegExp, number]> = [
    [/^(\w+Error):/, 1],              // TypeError:, ReferenceError:
    [/^(\w+Exception):/, 1],          // NullPointerException:
    [/(E[A-Z]{2,})(?:[\s:,]|$)/, 1],  // ECONNREFUSED, ENOTFOUND
    [/^(panic):/, 1],                 // Go panic
    [/^(FATAL|CRITICAL):?/i, 1],      // Generic fatal
    [/SQLSTATE\[(\w+)\]/, 1],         // Database errors
  ];
  
  for (const [pattern, group] of patterns) {
    const match = message.match(pattern);
    if (match) return match[group];
  }
  return 'Error'; // Default fallback
}
```

### Deduplication

Errors are deduplicated by hash: `sha256(source + error_type + normalized_message)`.

The message is normalized before hashing:
- Trim whitespace
- Remove timestamps (ISO8601 patterns)
- Remove UUIDs
- Remove memory addresses (0x...)
- Collapse multiple spaces to single space
- **Case is preserved** (not lowercased) to distinguish between different error types

**Deduplication rules:**

| Existing Status | New Error Behavior |
|-----------------|-------------------|
| `pending`, `analyzing`, `suggested`, `fixing` | Drop (already being handled) |
| `fixed`, `failed`, `ignored` | Create new entry (error recurred) |

**Recurring Error Handling:** When a duplicate is detected for an error in `fixed`, `failed`, or `ignored` status, a new error entry is created with:
- `created_at` set to the **new** detection time
- `fix_attempts` reset to 0
- `suggestion` and `fix_result` cleared (NULL)
- `status` set to `pending`

---

## Fix Pipeline

### Status Flow

```
Error Detected
     |
     v
  pending ----------------------------------------.
     |                                            |
     v                                            |
  analyzing --- failure ------------------------->|
     |                                            |
     v                                            |
  suggested -----------------------------------.  |
     |                                         |  |
     | <-- [human approval in manual mode]     |  |
     v                                         |  |
  fixing ---- failure ------------------------>|  |
     |                                         |  |
     v                                         |  |
  [verification]                               |  |
     |                                         |  |
  +--+--+                                      |  |
  |     |                                      |  |
pass   fail                                    |  |
  |     |                                      |  |
  v     +---- (attempts < max) --------------->+  |
fixed         |                                   |
              |                                   |
              +---- (attempts >= max) -------> failed

User action: -------------------------------------> ignored
```

**Status definitions:**

| Status | Description |
|--------|-------------|
| `pending` | Detected, awaiting analysis |
| `analyzing` | Agent is currently analyzing |
| `suggested` | Analysis complete, awaiting fix |
| `fixing` | Agent is currently applying fix |
| `fixed` | Fix verified successfully |
| `failed` | Max attempts exceeded |
| `ignored` | User chose to ignore |

### Pipeline Overview

```
Error Detected
     |
     v
+-----------------+
|  Queue (FIFO)   |<--- Serialized (one fix at a time)
+-----------------+
         |
         v
+-----------------+
|  Acquire Lock   |---- Fail if locked by another process
+-----------------+
         |
         v
+-----------------+
|    Analyze      |---- Agent reads context, writes analysis
+-----------------+
         |
         v
+-----------------+
|  Human Approval |---- Skip in autonomous mode
+-----------------+
         |
         v
+-----------------+
|      Fix        |---- Agent reads analysis, modifies code
+-----------------+
         |
         v
+-----------------+
|    Verify       |---- Run tests, health checks
+-----------------+
         |
    +----+----+
    |         |
 Success    Failure
    |         |
    v         v
  fixed    increment attempts
              |
         +----+----+
         |         |
     < max      >= max
         |         |
         v         v
      pending    failed
```

### Phase Failure Handling

When the analysis or fix phase fails (agent exhausts retries, produces invalid output, times out, or reports `success: false`):

1. Increment `fix_attempts`
2. Store diagnostic info in the appropriate database field:
   - **Analysis phase failures**: Store in `suggestion` field (JSON with `{ error: true, diagnostic: "..." }`)
   - **Fix phase failures**: Store in `fix_result` field (JSON with `{ error: true, diagnostic: "..." }`)
   - **Agent reports `success: false`**: Store the full output in `fix_result` (the agent's `notes` field explains why)
3. If `fix_attempts >= max_attempts_per_error`: set status to `failed`
4. Otherwise: set status to `pending` (will retry from analysis phase)
5. Release lock
6. Log appropriate activity (`analysis_failed` or `fix_failed`)

**Important:** A single "attempt" covers the full cycle: analysis → fix → verification. If analysis fails, the attempt still counts. This prevents infinite loops on errors the agent cannot analyze.

### Autonomous Mode Queue Processing

In autonomous mode, the fix queue is processed automatically:

- **Trigger**: After each error detection, and after each fix completion (success or failure)
- **Check**: Is the queue non-empty and no fix currently in progress?
- **Selection**: Oldest `pending` or `suggested` error by `created_at` (FIFO)
- **Execution**: One fix at a time (serialized)
```typescript
async function processQueueIfReady(): Promise<void> {
  if (fixInProgress) return;
  
  const next = db.get(`
    SELECT id FROM errors 
    WHERE status IN ('pending', 'suggested')
    ORDER BY created_at ASC
    LIMIT 1
  `);
  
  if (next) {
    await processError(next.id);
  }
}

// Called after:
// - New error detected
// - Fix completes (success or failure)
```

### Lock Lifecycle

A lock is acquired when processing begins and held until the error reaches a terminal or stable state:

- **Acquired**: Start of analysis (for `pending`) or start of fix (for `suggested`)
- **Held through**: Analysis → suggested → fix → verification
- **Released when**: Status becomes `fixed`, `failed`, or `ignored`
- **Released when**: `--analyze-only` flag used and analysis completes successfully
- **Released early if**: Verification fails and error returns to `pending` for retry

This prevents another process from picking up a `suggested` error while the original process is between analysis and fix phases.

### Context Files

The agent receives instructions via context files, avoiding command-line size limits.

#### Directory Structure

```
.selfheal/
├── errors.db
├── daemon.log
├── daemon.log.1          # Rotated logs
└── context/
    ├── 2025-01-27-error-1-attempt-0-analyze.md     # Analysis phase input
    ├── 2025-01-27-error-1-attempt-0-analysis.yaml  # Analysis phase output
    ├── 2025-01-27-error-1-attempt-0-fix.md         # Fix phase input (includes analysis)
    ├── 2025-01-27-error-1-attempt-0-result.yaml    # Fix phase output
    ├── 2025-01-28-error-1-attempt-1-analyze.md     # Retry on different day
    └── 2025-01-28-error-1-attempt-1-analysis.yaml
```

Context files are prefixed with the creation date (`YYYY-MM-DD`) and include the attempt number (`fix_attempts` value) to prevent collisions on retry and for easy identification.

Context files are written and read using UTF-8 encoding. Non-UTF8 characters in log content are replaced with the Unicode replacement character (U+FFFD).

#### Context File Format (Analysis Phase)

`.selfheal/context/{date}-error-{id}-attempt-{attempt}-analyze.md`:

```markdown
# Self-Heal Task

## Mode
analyze

## Project
- Name: my-app
- Root: /absolute/path/to/project

## Error Details
- ID: 1
- Source: backend
- Type: ConnectionError
- Detected: 2025-01-27T10:30:00Z
- Fix Attempts: 0

### Message
ECONNREFUSED 127.0.0.1:5432

### Stack Trace
    at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16)
    at PostgresConnection.connect (pg/lib/connection.js:45:12)

### Context (surrounding log lines)
[2025-01-27T10:29:55Z] INFO: Starting database connection...
[2025-01-27T10:29:56Z] DEBUG: Using connection string: postgres://localhost:5432/mydb
---ERROR---
[2025-01-27T10:30:00Z] ERROR: ECONNREFUSED 127.0.0.1:5432
    at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16)
    at PostgresConnection.connect (pg/lib/connection.js:45:12)
---END ERROR---
[2025-01-27T10:30:00Z] WARN: Retrying connection in 5s...
[2025-01-27T10:30:05Z] ERROR: ECONNREFUSED 127.0.0.1:5432

## Instructions

1. Investigate the project structure to understand the codebase
2. Identify the root cause of this error
3. Determine what files need to be modified
4. Assess your confidence in the fix

Write your analysis to: `.selfheal/context/2025-01-27-error-1-attempt-0-analysis.yaml`

Use this exact YAML format:
```yaml
summary: One sentence summary of the problem
root_cause: |
  Detailed explanation of root cause
  Can be multiple lines
suggested_fix: |
  What changes to make
  Step by step if needed
files_to_modify:
  - path/to/file1
  - path/to/file2
confidence: high | medium | low
```

## Constraints
- Do NOT modify any files during analysis
- If you cannot determine the cause, set confidence to "low"
- Be specific about file paths relative to project root
- WARNING: If a fix fails and is retried, any file modifications from previous attempts will persist
```

#### Context File Format (Fix Phase)

`.selfheal/context/{date}-error-{id}-attempt-{attempt}-fix.md`:

For fix mode, the context includes the previous analysis:

> **Note:** The example below shows the second fix attempt (attempt 1) after the first attempt (attempt 0) failed verification.

```markdown
# Self-Heal Task

## Mode
fix

## Project
- Name: my-app
- Root: /absolute/path/to/project

## Error Details
- ID: 1
- Source: backend
- Type: ConnectionError
- Detected: 2025-01-27T10:30:00Z
- Fix Attempts: 1

### Message
ECONNREFUSED 127.0.0.1:5432

### Stack Trace
    at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16)

## Previous Analysis
summary: PostgreSQL container not starting due to port conflict
root_cause: |
  Port 5432 is already bound by the host PostgreSQL service.
  The Docker container cannot acquire the port.
suggested_fix: |
  Change docker-compose.yaml port mapping from 5432:5432 to 5433:5432.
  Update DATABASE_URL in .env to use port 5433.
files_to_modify:
  - docker-compose.yaml
  - .env
confidence: high

## Instructions

1. Read the previous analysis above
2. Implement the suggested fix
3. Follow existing code style and conventions
4. Make minimal, targeted changes

Write your results to: `.selfheal/context/2025-01-27-error-1-attempt-1-result.yaml`

Use this exact YAML format:
```yaml
success: true | false
summary: One sentence describing what was done
files_changed:
  - path: relative/path/to/file
    change: Description of change made
notes: |
  Optional additional notes
  Can be multiple lines
```

## Constraints
- Make the smallest change that resolves the issue
- Do NOT change unrelated code
- If the fix cannot be applied, set success to false and explain in notes
- WARNING: If this fix fails verification, the modified files will remain changed for the next retry attempt
```

#### Output Formats

**Analysis output** (`.selfheal/context/{date}-error-{id}-attempt-{attempt}-analysis.yaml`):

```yaml
summary: PostgreSQL container not starting due to port conflict
root_cause: |
  Port 5432 is already bound by the host PostgreSQL service.
  The Docker container cannot acquire the port.
suggested_fix: |
  Change docker-compose.yaml port mapping from 5432:5432 to 5433:5432.
  Update DATABASE_URL in .env to use port 5433.
files_to_modify:
  - docker-compose.yaml
  - .env
confidence: high
```

Required fields: `summary`, `root_cause`, `suggested_fix`, `files_to_modify`, `confidence`

**Fix result** (`.selfheal/context/{date}-error-{id}-attempt-{attempt}-result.yaml`):

```yaml
success: true
summary: Updated PostgreSQL port mapping to 5433
files_changed:
  - path: docker-compose.yaml
    change: Changed port mapping from "5432:5432" to "5433:5432"
  - path: .env
    change: Updated DATABASE_URL to use port 5433
notes: |
  Application will now connect on port 5433.
  No other configuration changes needed.
```

Required fields: `success`, `summary`
Optional fields: `files_changed`, `notes`

#### Output Parsing and Validation

```typescript
interface AnalysisOutput {
  summary: string;
  root_cause: string;
  suggested_fix: string;
  files_to_modify: string[];
  confidence: 'high' | 'medium' | 'low';
}

interface FixOutput {
  success: boolean;
  summary: string;
  files_changed?: Array<{ path: string; change: string }>;
  notes?: string;
}

function validateAnalysisOutput(data: unknown): asserts data is AnalysisOutput {
  const required = ['summary', 'root_cause', 'suggested_fix', 'files_to_modify', 'confidence'];
  for (const field of required) {
    if (!(field in (data as any))) {
      throw new Error(`Missing required field: ${field}`);
    }
  }
  if (!['high', 'medium', 'low'].includes((data as any).confidence)) {
    throw new Error(`Invalid confidence value: ${(data as any).confidence}`);
  }
}

function validateFixOutput(data: unknown): asserts data is FixOutput {
  if (!('success' in (data as any))) {
    throw new Error('Missing required field: success');
  }
  if (!('summary' in (data as any))) {
    throw new Error('Missing required field: summary');
  }
}
```

#### Context File Cleanup

Context files are cleaned based on age:

- Files are named with date, attempt, and phase: `2025-01-27-error-1-attempt-0-analyze.md`, `2025-01-27-error-1-attempt-0-fix.md`
- `cleanup.context_max_age_days` controls retention (default: 7 days)
- `selfheal clean` removes files older than the configured age
- `selfheal clean --dry-run` shows what would be removed
- Context files for errors in `analyzing` or `fixing` status are **never deleted**, regardless of age (this includes both `-analyze.md` and `-fix.md` files for the error)

The date prefix is the date the context file is created (not when the error was detected). For retries, a new context file is created with the current date and incremented attempt number. Old context files for the same error remain until cleaned by age.

> **Size Limit:** Context files are limited to `cleanup.context_max_size_kb` (default: 256KB). If content exceeds this:
> 1. First, truncate the stack trace to 32KB maximum, keeping the first and last 16KB with `[...truncated...]` in between
> 2. If still over limit, remove lines from the **beginning** of the raw log (oldest context first)
> 3. Insert at the start: `[...{N} lines truncated due to size limit...]`
> 4. Keep the error line intact

---

## Verification

After a fix is applied:

1. **Wait**: Sleep for `wait_after_fix` duration (default: 5s)
2. **Test commands**: Run each command in `test_commands` sequentially
   - Commands execute in a shell (`shell: true` in spawn options)
   - On Windows, uses `cmd.exe`; on Unix, uses `/bin/sh`
   - For cross-platform compatibility, use npm scripts or explicit shell commands
   - Working directory is the project root
   - Stop on first non-zero exit code
   - Capture stdout/stderr for logging
   - Timeout: `test_command_timeout` per command (default: 5m)
3. **Health checks**: HTTP GET each URL in `health_checks`
   - Expect 2xx response (200-299)
   - Follows redirects (up to 5 hops). If the 5th response is still a redirect, treat as failure with message "Too many redirects"
   - Sends `User-Agent: selfheal/1.0` header
   - Does not send request body
   - Timeout: `health_check_timeout` (default: 10s) per check
   - Stop on first failure

### Outcomes

| Result | Action |
|--------|--------|
| All pass | Set status to `fixed`, log success |
| Any fail | Increment `fix_attempts`, set status based on attempts |

### Empty Verification Config

- If `test_commands` is empty or undefined: skip test command phase
- If `health_checks` is empty or undefined: skip health check phase  
- If both are empty: verification automatically passes

### No Automatic Rollback

When verification fails, modified files remain in place. The error returns to `pending` status for retry, which will re-analyze the (now-modified) codebase. Users who want rollback should use version control (e.g., `git checkout` or `git stash`).

### Post-Verification Status

```typescript
function determinePostVerificationStatus(
  verificationPassed: boolean,
  currentAttempts: number,
  maxAttempts: number
): { status: ErrorStatus; shouldRetry: boolean } {
  if (verificationPassed) {
    return { status: 'fixed', shouldRetry: false };
  }
  
  const newAttempts = currentAttempts + 1;
  
  if (newAttempts >= maxAttempts) {
    return { status: 'failed', shouldRetry: false };
  }
  
  return { status: 'pending', shouldRetry: true };
}
```

### Verification Failure Handling

When verification fails:
1. Log which step failed and why (command output or HTTP status)
2. Increment `fix_attempts`
3. If under limit: set status to `pending`, add to back of fix queue (autonomous mode)
4. If at limit: set status to `failed`, log final failure

---

## Storage

All data stored in `.selfheal/` in project root.

> **Initialization Timing:** The `.selfheal/` directory and `errors.db` database are created lazily on first command that requires them (`watch`, `status`, `fix`, `show`, `logs`, `clean`). The `init` command only creates `selfheal.yaml`.

### Database Configuration

SQLite database at `.selfheal/errors.db`:

```typescript
const db = new Database('.selfheal/errors.db');
db.pragma('journal_mode = WAL');      // Write-ahead logging for concurrent reads
db.pragma('busy_timeout = 5000');     // Wait up to 5s for locks
db.pragma('synchronous = NORMAL');    // Balance durability and performance
```

### Schema Version

The database includes a schema version for future migrations:

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

For v1: Single schema version (1). On version mismatch, exit with code 4 and the following message:

```
Error: Database schema version mismatch.
  Expected: 1
  Found: {actual_version}

This database was created by a different version of selfheal.
To resolve:
  1. Back up .selfheal/errors.db
  2. Delete .selfheal/errors.db
  3. Restart selfheal (a new database will be created)

Note: This will clear error history. Alternatively, downgrade/upgrade selfheal to match the database version.
```

Future versions will implement proper migrations.

### Database Schema

#### errors

```sql
CREATE TABLE errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  source TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  error_type TEXT NOT NULL,
  message TEXT NOT NULL,
  stack_trace TEXT,
  raw_log TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  suggestion TEXT,
  fix_result TEXT,
  fix_attempts INTEGER NOT NULL DEFAULT 0,
  locked_by TEXT,
  locked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_errors_hash ON errors(hash);
CREATE INDEX idx_errors_status ON errors(status);
CREATE INDEX idx_errors_created_at ON errors(created_at);
```

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key, auto-increment |
| hash | TEXT | Dedup key: `sha256(source + error_type + normalized_message)` |
| source | TEXT | Log source name that detected this |
| timestamp | TEXT | ISO8601 when error occurred in logs |
| error_type | TEXT | Extracted type (e.g., "TypeError", "ECONNREFUSED") |
| message | TEXT | Error message (first line) |
| stack_trace | TEXT | Stack trace if present (nullable) |
| raw_log | TEXT | Original log lines with context |
| status | TEXT | `pending`, `analyzing`, `suggested`, `fixing`, `fixed`, `failed`, `ignored` |
| suggestion | TEXT | JSON string: parsed analysis or diagnostic info |
| fix_result | TEXT | JSON string: parsed fix result or diagnostic info |
| fix_attempts | INTEGER | Number of fix attempts made |
| locked_by | TEXT | Process identifier holding lock (nullable) |
| locked_at | TEXT | ISO8601 when lock was acquired (nullable) |
| created_at | TEXT | ISO8601 first seen |
| updated_at | TEXT | ISO8601 last modified |

#### watcher_state

```sql
CREATE TABLE watcher_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  autonomous INTEGER NOT NULL DEFAULT 0,
  project_root TEXT NOT NULL,
  command_line TEXT NOT NULL
);
```

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Always 1 (singleton row) |
| pid | INTEGER | Process ID of watcher |
| started_at | TEXT | ISO8601 when started |
| autonomous | INTEGER | 0 = manual, 1 = autonomous |
| project_root | TEXT | Absolute path for validation |
| command_line | TEXT | Full command for validation |

#### activity_log

```sql
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL,
  error_id INTEGER,
  details TEXT,
  FOREIGN KEY (error_id) REFERENCES errors(id)
);

CREATE INDEX idx_activity_log_timestamp ON activity_log(timestamp);
CREATE INDEX idx_activity_log_error_id ON activity_log(error_id);
```

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key, auto-increment |
| timestamp | TEXT | ISO8601 when action occurred |
| action | TEXT | Event type (see below) |
| error_id | INTEGER | Related error (nullable) |
| details | TEXT | JSON string with additional context |

**Action types:**

| Action | Description |
|--------|-------------|
| `watcher_start` | Watcher process started |
| `watcher_stop` | Watcher process stopped (graceful) |
| `error_detected` | New error detected in logs |
| `error_deduplicated` | Error dropped (duplicate of existing) |
| `analysis_start` | Agent analysis started |
| `analysis_complete` | Agent analysis finished successfully |
| `analysis_failed` | Agent analysis failed |
| `analysis_timeout` | Agent analysis timed out |
| `fix_start` | Agent fix started |
| `fix_complete` | Agent fix finished successfully |
| `fix_failed` | Agent fix failed |
| `fix_timeout` | Agent fix timed out |
| `verification_start` | Verification started |
| `verification_pass` | All verification checks passed |
| `verification_fail` | Verification failed |
| `error_ignored` | User ignored error |
| `lock_acquired` | Lock acquired on error |
| `lock_released` | Lock released on error |
| `lock_expired` | Stale lock was cleared |
| `stale_recovery` | Stale errors recovered at startup |

---

## Concurrency and Locking

### Problem

Multiple processes may try to fix the same error:
- Daemon running in autonomous mode
- User running `selfheal fix <id>`
- Multiple terminal sessions

### Solution: Optimistic Locking

Each error can be locked by a single process:

```typescript
interface LockInfo {
  lockedBy: string;   // Process identifier: `${hostname}:${pid}:${startTime}`
  lockedAt: Date;
}

const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function generateLockId(): string {
  return `${os.hostname()}:${process.pid}:${Date.now()}`;
}

async function acquireLock(errorId: number, lockId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const expiryThreshold = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString();
  
  // Try to acquire lock, clearing expired locks in the process
  const result = db.run(`
    UPDATE errors
    SET locked_by = ?, locked_at = ?, updated_at = ?
    WHERE id = ?
      AND (
        locked_by IS NULL
        OR locked_at < ?
      )
  `, [lockId, now, now, errorId, expiryThreshold]);
  
  if (result.changes === 0) {
    // Lock not acquired - check why
    const error = db.get('SELECT locked_by, locked_at FROM errors WHERE id = ?', [errorId]);
    if (error?.locked_by) {
      logger.debug(`Error ${errorId} locked by ${error.locked_by} since ${error.locked_at}`);
    }
    return false;
  }
  
  logActivity('lock_acquired', errorId, { lockId });
  return true;
}

async function releaseLock(errorId: number, lockId: string): Promise<void> {
  const result = db.run(`
    UPDATE errors
    SET locked_by = NULL, locked_at = NULL, updated_at = ?
    WHERE id = ? AND locked_by = ?
  `, [new Date().toISOString(), errorId, lockId]);
  
  if (result.changes > 0) {
    logActivity('lock_released', errorId, { lockId });
  }
}
```

### Status Transition Validation

Before any status transition, verify the current status is expected:

```typescript
async function transitionStatus(
  errorId: number,
  expectedStatus: ErrorStatus | ErrorStatus[],
  newStatus: ErrorStatus,
  lockId: string
): Promise<boolean> {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const placeholders = expected.map(() => '?').join(', ');
  
  const result = db.run(`
    UPDATE errors
    SET status = ?, updated_at = ?
    WHERE id = ?
      AND locked_by = ?
      AND status IN (${placeholders})
  `, [newStatus, new Date().toISOString(), errorId, lockId, ...expected]);
  
  if (result.changes === 0) {
    const current = db.get('SELECT status, locked_by FROM errors WHERE id = ?', [errorId]);
    logger.warn(`Status transition failed for error ${errorId}`, {
      expected,
      newStatus,
      actual: current?.status,
      lockedBy: current?.locked_by,
      ourLock: lockId,
    });
    return false;
  }
  
  return true;
}
```

### Lock Expiry

Locks expire after 10 minutes to handle crashed processes:

- On lock acquisition: clear any lock older than 10 minutes
- Log `lock_expired` when clearing stale locks
- Stale lock indicates previous process crashed during fix

---

## Daemon Management

### Starting the Daemon

`selfheal watch --daemon` (Linux/macOS only):

1. Validate config and agent CLI
2. Check platform (exit with error on Windows)
3. Check no existing watcher (query watcher_state, validate PID)
4. Spawn detached child process
5. Child writes state to watcher_state table
6. Parent waits for confirmation (up to 5s), then exits

```typescript
function daemonize(): number {
  if (process.platform === 'win32') {
    throw new UserError(
      'Daemon mode is not supported on Windows.\n' +
      'Use foreground mode: selfheal watch --autonomous\n' +
      'Or use a process manager like PM2: pm2 start selfheal -- watch --autonomous'
    );
  }
  
  const scriptPath = process.argv[1];
  const args = ['watch', '--daemon-child', ...getForwardedArgs()];
  
  const child = spawn(process.execPath, [scriptPath, ...args], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    cwd: process.cwd(),
    env: { ...process.env, SELFHEAL_DAEMON: '1' },
  });
  
  child.unref();
  return child.pid!;
}
```

The `--daemon-child` flag (internal, hidden from help) indicates the process is the daemon child and should not re-daemonize. If the user passes `--daemon-child` manually (without the `SELFHEAL_DAEMON` env var set), exit with an error: `"Internal flag --daemon-child cannot be used directly."`

### Stopping the Daemon

`selfheal stop`:

1. Read watcher_state from DB
2. If no state: report "not running"
3. Validate PID is our process (not stale)
4. Send SIGTERM
5. Wait for graceful shutdown (up to 30s)
6. If still running: send SIGKILL
7. Clear watcher_state
8. Report result

```typescript
async function stopDaemon(): Promise<void> {
  const state = getWatcherState();
  
  if (!state) {
    console.log('No watcher running');
    return;
  }
  
  if (!isOurProcess(state.pid, state.projectRoot)) {
    console.log('Stale watcher state (process no longer exists)');
    clearWatcherState();
    return;
  }
  
  console.log(`Stopping watcher (PID ${state.pid})...`);
  
  // Send SIGTERM
  process.kill(state.pid, 'SIGTERM');
  
  // Wait for graceful shutdown
  const stopped = await waitForProcessExit(state.pid, 30000);
  
  if (!stopped) {
    console.log('Watcher did not stop gracefully, forcing...');
    process.kill(state.pid, 'SIGKILL');
    await waitForProcessExit(state.pid, 5000);
  }
  
  clearWatcherState();
  console.log('Watcher stopped');
}
```

#### PID Validation

After reboot, the stored PID might belong to a different process:

```typescript
function isOurProcess(pid: number, expectedRoot: string): boolean {
  try {
    // Check if process exists
    process.kill(pid, 0);
    
    // Verify it's a selfheal process for this project
    let cmdline: string;
    
    if (process.platform === 'win32') {
      cmdline = execSync(
        `wmic process where ProcessId=${pid} get CommandLine /format:list`,
        { encoding: 'utf8', timeout: 5000 }
      );
    } else {
      cmdline = execSync(
        `ps -p ${pid} -o args=`,
        { encoding: 'utf8', timeout: 5000 }
      );
    }
    
    return cmdline.includes('selfheal') &&
           cmdline.includes(expectedRoot);
  } catch {
    return false; // Process doesn't exist or can't read cmdline
  }
}
```

> **Note:** On newer Windows versions where `wmic` is unavailable, fall back to PowerShell: `powershell -Command "(Get-Process -Id ${pid}).CommandLine"`

### Signal Handling

The daemon handles signals for graceful shutdown:

```typescript
function setupSignalHandlers(orchestrator: WatcherOrchestrator): void {
  let shuttingDown = false;
  
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    
    logger.info(`Received ${signal}, shutting down...`);
    
    // Stop accepting new log events
    orchestrator.stopWatchers();
    
    // Wait for in-progress fix to complete (up to 30s)
    const currentFix = orchestrator.getCurrentFix();
    if (currentFix) {
      logger.info('Waiting for current fix to complete...');
      
      const timeout = setTimeout(() => {
        logger.warn('Fix did not complete in time, aborting');
        currentFix.abort();
      }, 30000);
      
      try {
        await currentFix.promise;
      } finally {
        clearTimeout(timeout);
      }
    }
    
    // Release any held locks
    await orchestrator.releaseAllLocks();
    
    // Clean up
    await db.close();
    clearWatcherState();
    
    logActivity('watcher_stop', null, { signal, graceful: true });
    logger.info('Shutdown complete');
    process.exit(0);
  };
  
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  
  // SIGHUP is not available on Windows
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => shutdown('SIGHUP'));
  }
}
```

### Stale Status Recovery

If the daemon crashes mid-fix (SIGKILL, power loss, etc.), errors may be left in `analyzing` or `fixing` status with stale locks. On watcher startup, recover these orphaned errors:

```typescript
function recoverStaleErrors(): void {
  const staleThreshold = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString();
  const now = new Date().toISOString();

  // Reset stuck errors with expired locks back to pending
  const result1 = db.run(`
    UPDATE errors
    SET status = 'pending', locked_by = NULL, locked_at = NULL, updated_at = ?
    WHERE status IN ('analyzing', 'fixing')
      AND locked_at < ?
  `, [now, staleThreshold]);

  // Clear stale locks on suggested errors (don't change status)
  const result2 = db.run(`
    UPDATE errors
    SET locked_by = NULL, locked_at = NULL, updated_at = ?
    WHERE status = 'suggested'
      AND locked_by IS NOT NULL
      AND locked_at < ?
  `, [now, staleThreshold]);

  const total = result1.changes + result2.changes;
  if (total > 0) {
    logger.warn(`Recovered ${result1.changes} stale error(s), cleared ${result2.changes} stale lock(s)`);
    logActivity('stale_recovery', null, { reset: result1.changes, unlocked: result2.changes });
  }
}
```

Call `recoverStaleErrors()` at daemon startup before starting watchers. This ensures errors stuck due to a previous crash are retried.

### Manual Fix with Daemon Running

When running `selfheal fix <id>` while a daemon is running:

```typescript
async function checkDaemonConflict(): Promise<void> {
  const state = getWatcherState();
  
  if (!state) return; // No daemon running
  
  if (!isOurProcess(state.pid, state.projectRoot)) {
    // Stale state, clear it
    clearWatcherState();
    return;
  }
  
  if (state.autonomous) {
    throw new UserError(
      'Cannot run manual fix while daemon is in autonomous mode.\n' +
      'The daemon will automatically fix errors.\n' +
      "Run 'selfheal stop' first if you want manual control."
    );
  }
  
  // Manual mode daemon - allow fix to proceed
  // The daemon only detects errors, doesn't fix them
  logger.debug('Daemon running in manual mode, proceeding with fix');
}
```

### Status Check

`selfheal status`:

```typescript
async function showStatus(): Promise<void> {
  const state = getWatcherState();
  
  if (state && isOurProcess(state.pid, state.projectRoot)) {
    const mode = state.autonomous ? 'autonomous' : 'manual';
    const uptime = formatDuration(Date.now() - new Date(state.startedAt).getTime());
    console.log(`Watcher: running since ${state.startedAt} (${mode} mode, up ${uptime})`);
    console.log(`PID: ${state.pid}`);
  } else {
    if (state) clearWatcherState(); // Clean up stale state
    console.log('Watcher: not running');
  }
  
  console.log('');
  
  // Show error summary
  const counts = db.get(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'suggested' THEN 1 ELSE 0 END) as suggested,
      SUM(CASE WHEN status IN ('analyzing', 'fixing') THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'fixed' AND date(updated_at) = date('now') THEN 1 ELSE 0 END) as fixed_today,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM errors
  `);
  
  console.log(`Pending: ${counts.pending}`);
  console.log(`Suggested (awaiting fix): ${counts.suggested}`);
  console.log(`In progress: ${counts.in_progress}`);
  console.log(`Fixed today: ${counts.fixed_today}`);
  console.log(`Failed: ${counts.failed}`);
  
  // List pending/suggested errors
  const errors = db.all(`
    SELECT id, error_type, source, message, status, created_at
    FROM errors
    WHERE status IN ('pending', 'suggested')
    ORDER BY created_at ASC
    LIMIT 20
  `);
  
  if (errors.length > 0) {
    console.log('');
    console.log('Actionable Errors:');
    console.log('ID  Status     Type             Source   Message');
    for (const e of errors) {
      const msg = e.message.length > 40 ? e.message.slice(0, 37) + '...' : e.message;
      console.log(`${e.id.toString().padEnd(4)}${e.status.padEnd(11)}${e.error_type.padEnd(17)}${e.source.padEnd(9)}${msg}`);
    }
  }
}
```

---

## Logging

### Log File

All watcher activity logged to `.selfheal/daemon.log`.

Format:
```
2025-01-27T10:30:00.000Z [INFO] Watcher started (autonomous=false)
2025-01-27T10:30:01.000Z [INFO] Watching: backend (file: ./logs/backend.log)
2025-01-27T10:30:02.000Z [WARN] Log file not found: ./logs/api.log - waiting for creation
2025-01-27T10:30:15.000Z [INFO] Error detected: #1 ConnectionError - ECONNREFUSED 127.0.0.1:5432
2025-01-27T10:30:15.000Z [INFO] Queued error #1 for review
```

### Log Levels

| Level | Description |
|-------|-------------|
| `DEBUG` | Detailed diagnostic info (lock operations, state transitions) |
| `INFO` | Normal operational messages (errors detected, fixes applied) |
| `WARN` | Potential issues (file not found, retries, timeouts) |
| `ERROR` | Failures requiring attention (agent failures, verification failures) |

### Terminal Output

In foreground mode, logs are written to both file and terminal (stderr).

In daemon mode, logs are written to file only.

### Verbosity Control

| Flag | DEBUG | INFO | WARN | ERROR |
|------|-------|------|------|-------|
| `--quiet`, `-q` | ✗ | ✗ | ✓ | ✓ |
| (default) | ✗ | ✓ | ✓ | ✓ |
| `--verbose` | ✓ | ✓ | ✓ | ✓ |

### Log Rotation

Built-in log rotation based on file size:

```typescript
const LOG_ROTATION = {
  maxSize: 10 * 1024 * 1024, // 10 MB
  maxFiles: 5,
};
```

Rotation behavior:
1. Before each write, check if `daemon.log` exceeds `maxSize`
2. If so, rotate files: `.log.4` → `.log.5` (deleted if exists), `.log.3` → `.log.4`, etc.
3. Rename `daemon.log` to `daemon.log.1`
4. Create new `daemon.log`

```
.selfheal/
├── daemon.log        # Current (< 10MB)
├── daemon.log.1      # Previous
├── daemon.log.2
├── daemon.log.3
├── daemon.log.4
└── daemon.log.5      # Oldest (deleted on next rotation)
```

---

## Project Structure

```
selfheal/
├── src/
│   ├── cli/
│   │   ├── index.ts              # Entry point, commander setup
│   │   └── commands/
│   │       ├── init.ts
│   │       ├── watch.ts
│   │       ├── stop.ts
│   │       ├── status.ts
│   │       ├── fix.ts
│   │       ├── show.ts
│   │       ├── ignore.ts
│   │       ├── logs.ts
│   │       ├── config.ts         # config validate
│   │       ├── clean.ts          # context cleanup
│   │       └── version.ts
│   ├── agents/
│   │   ├── types.ts              # AgentConfig, AgentResult, Agent interface
│   │   ├── base.ts               # BaseAgent with spawn/output/timeout logic
│   │   ├── claude.ts             # Claude-specific handling (if any)
│   │   ├── gemini.ts             # Gemini-specific handling (if any)
│   │   ├── codex.ts              # Codex-specific handling (if any)
│   │   ├── defaults.ts           # AGENT_DEFAULTS
│   │   └── index.ts              # createAgent factory
│   ├── watcher/
│   │   ├── index.ts              # Watcher orchestrator, event queue
│   │   ├── sources/
│   │   │   ├── types.ts          # LogSource interface
│   │   │   ├── file.ts           # FileSource
│   │   │   ├── docker.ts         # DockerSource
│   │   │   └── command.ts        # CommandSource
│   │   └── parser.ts             # Error detection, multi-line buffering, context window
│   ├── fixer/
│   │   ├── index.ts              # Fix orchestrator
│   │   ├── context.ts            # Context file generation
│   │   ├── verifier.ts           # Test/health check runner
│   │   ├── queue.ts              # Fix queue management
│   │   └── lock.ts               # Locking utilities
│   ├── db/
│   │   ├── index.ts              # Database wrapper (WAL mode, connection management)
│   │   ├── schema.ts             # Table definitions, schema version
│   │   ├── migrations.ts         # Schema migrations (v1: single version)
│   │   └── queries.ts            # Typed query functions
│   ├── config/
│   │   ├── schema.ts             # Zod schema
│   │   ├── loader.ts             # Load and validate config
│   │   └── defaults.ts           # Default values
│   └── utils/
│       ├── logger.ts             # Logging utility with rotation
│       ├── hash.ts               # SHA256 hashing, message normalization
│       ├── daemon.ts             # Daemonization, signal handling
│       ├── process.ts            # CLI check, spawn helpers, timeout
│       ├── duration.ts           # Duration string parsing
│       └── http.ts               # Health check client
├── test/
│   ├── unit/
│   │   ├── parser.test.ts
│   │   ├── config.test.ts
│   │   ├── hash.test.ts
│   │   ├── context.test.ts
│   │   ├── error-type.test.ts
│   │   ├── duration.test.ts
│   │   ├── lock.test.ts
│   │   └── agent-output.test.ts
│   ├── integration/
│   │   ├── db.test.ts
│   │   ├── file-source.test.ts
│   │   ├── docker-source.test.ts
│   │   ├── command-source.test.ts
│   │   └── verifier.test.ts
│   ├── e2e/
│   │   ├── manual-flow.test.ts
│   │   ├── autonomous-flow.test.ts
│   │   ├── concurrent-fix.test.ts
│   │   └── daemon-lifecycle.test.ts
│   ├── fixtures/
│   │   ├── logs/                 # Sample log files
│   │   ├── configs/              # Valid and invalid configs
│   │   └── agent-responses/      # Canned YAML outputs (valid, invalid, missing)
│   └── helpers/
│       ├── mock-agent.ts         # Mock agent for testing
│       └── test-utils.ts         # Common test utilities
├── .gitignore
├── .eslintrc.cjs
├── .prettierrc
├── tsconfig.json
├── vitest.config.ts
├── package.json
└── README.md
```

---

## Testing Strategy

### Unit Tests

Fast, isolated tests for pure functions:

| Module | Test Focus |
|--------|------------|
| parser.ts | Pattern matching, error type extraction, multi-line buffering, context window |
| config/schema.ts | Valid configs pass, invalid configs fail with clear errors |
| hash.ts | Consistent hashing, message normalization, edge cases |
| context.ts | Context file generation matches expected format |
| duration.ts | Parse valid durations, reject invalid ones |
| lock.ts | Lock acquisition, release, expiry logic |
| agent-output.ts | Parse valid YAML, handle invalid YAML, handle missing files |

### Integration Tests

Tests that touch real resources:

| Module | Test Focus |
|--------|------------|
| db/ | CRUD operations, migrations, concurrent access, WAL mode, locking |
| watcher/sources/file.ts | Detects changes, handles rotation, waits for creation |
| watcher/sources/command.ts | Executes commands, parses output, handles large output |
| watcher/sources/docker.ts | Streams logs, handles disconnection (requires Docker) |
| fixer/verifier.ts | Runs commands, checks HTTP endpoints, handles timeouts |

Docker source tests require Docker and are skipped in CI if unavailable:

```typescript
const describeWithDocker = process.env.DOCKER_AVAILABLE ? describe : describe.skip;

describeWithDocker('DockerSource', () => {
  // ...
});
```

### E2E Tests

Full workflow tests with mock agent:

| Test | Focus |
|------|-------|
| manual-flow.test.ts | Detect → analyze → approve → fix → verify |
| autonomous-flow.test.ts | Detect → auto-fix → verify |
| concurrent-fix.test.ts | Two processes trying to fix same error |
| daemon-lifecycle.test.ts | Start, status, stop, signal handling |

**E2E test structure:**

1. **Setup**: Create temp directory with config, mock agent script, fake log file
2. **Execute**: Start watcher, inject error into log, run fix commands
3. **Assert**: Error detected, correct status transitions, files created
4. **Cleanup**: Remove temp directory

**Mock agent** reads context file and writes canned responses:

```typescript
// test/helpers/mock-agent.ts
// Invoked as: node mock-agent.js "Read .selfheal/context/..."

const prompt = process.argv[2];

// Extract context file path from prompt
// Pattern: .selfheal/context/2025-01-27-error-1-attempt-0-analyze.md
const contextPath = prompt.match(/\.selfheal\/context\/[^\s]+/)?.[0];
if (!contextPath) {
  console.error('No context path found in prompt');
  process.exit(1);
}

const context = fs.readFileSync(contextPath, 'utf8');
const isAnalyze = contextPath.endsWith('-analyze.md');

// Determine output path based on input file
// -analyze.md -> -analysis.yaml
// -fix.md -> -result.yaml
const outputPath = isAnalyze
  ? contextPath.replace('-analyze.md', '-analysis.yaml')
  : contextPath.replace('-fix.md', '-result.yaml');

const response = isAnalyze
  ? MOCK_ANALYSIS_RESPONSE
  : MOCK_FIX_RESPONSE;

fs.writeFileSync(outputPath, response);
```

### Test Configuration

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['test/**', '**/*.d.ts'],
    },
    testTimeout: 30000,  // 30s for E2E tests that spawn processes
    hookTimeout: 30000,
    // Run all tests serially (required for E2E filesystem isolation)
    sequence: {
      concurrent: false,
    },
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
```

---

## Error Handling

### Error Types

```typescript
// User-facing errors (shown directly to user)
class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

// Internal errors (logged, wrapped for user)
class InternalError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'InternalError';
  }
}
```

### Missing Configuration

When any command except `init` is run without a `selfheal.yaml`:
- Exit with code 1 and message: `"No selfheal.yaml found in current directory. Run 'selfheal init' to create one."`

### User-Facing Error Messages

Clear, actionable messages:

```
Error: Agent CLI not found: 'claude' not found in PATH
  Install Claude Code: npm install -g @anthropic-ai/claude-code

Error: Config validation failed:
  - agent.timeout: Invalid duration string "5 minutes" (use format: 5m)
  - logs.sources[0]: 'interval' is required for command source type

Error: Cannot start watcher: already running (PID 12345)
  Run 'selfheal stop' first, or 'selfheal status' to check state

Error: Cannot run manual fix while daemon is in autonomous mode.
  The daemon will automatically fix errors.
  Run 'selfheal stop' first if you want manual control.

Error: Error #5 is currently being processed by another process.
  Wait for it to complete or check 'selfheal status'.

Error: Agent did not produce expected output after 3 attempts.
  Check .selfheal/daemon.log for details.

Error: Error #42 not found.

Error: Daemon mode is not supported on Windows.
  Use foreground mode: selfheal watch --autonomous
  Or use a process manager like PM2: pm2 start selfheal -- watch --autonomous
```

### Internal Error Logging

```typescript
try {
  await agent.analyze(contextPath);
} catch (err) {
  logger.error('Agent analysis failed', {
    error: err,
    errorId,
    contextPath,
    attempt: attemptNumber,
  });
  
  throw new UserError(
    `Analysis failed: ${err.message}\nCheck .selfheal/daemon.log for details`
  );
}
```

### Graceful Degradation

| Scenario | Behavior |
|----------|----------|
| Health check URL unreachable | Log warning, treat as verification failure |
| Agent output unparseable | Store raw content as diagnostic, mark as failure |
| Agent doesn't create output file | Store stdout/stderr, mark as failure |
| Agent reports `success: false` | Store output, treat as fix failure, retry if under limit |
| Log source fails | Log error, continue watching other sources |
| Log file doesn't exist | Log warning, wait for creation, continue with others |
| Docker container not running | Retry with backoff, continue with other sources |
| Agent times out | Kill process, retry up to limit, then mark failed |
| Lock acquisition fails | Skip error (being processed elsewhere), continue |
| Database locked | Wait up to 5s (busy_timeout), then fail operation |
| Test command times out | Kill process, treat as verification failure |

---

## Example Workflows

### Manual Mode

```bash
$ selfheal init
✓ Created selfheal.yaml
✓ Added .selfheal/ to .gitignore

Edit selfheal.yaml to configure your log sources and agent provider.

$ vi selfheal.yaml  # Configure log sources

$ selfheal config validate
✓ Config syntax valid
✓ Agent CLI found: claude (v1.2.3)
✓ All log sources accessible
✓ Config valid

$ selfheal watch
[10:30:00] Watcher started (manual mode)
[10:30:00] Watching: backend (file: ./logs/backend.log)
[10:30:15] 🔴 Error #1: ConnectionError - ECONNREFUSED 127.0.0.1:5432
           Run 'selfheal fix 1' to analyze and fix

$ selfheal status
Watcher: running since 2025-01-27T10:30:00Z (manual mode, up 2m)
PID: 12345

Pending: 1
Suggested (awaiting fix): 0
In progress: 0
Fixed today: 0
Failed: 0

Actionable Errors:
ID  Status     Type             Source   Message
1   pending    ConnectionError  backend  ECONNREFUSED 127.0.0.1:5432

$ selfheal fix 1
Analyzing error #1...
✓ Analysis complete (15s)

Summary: PostgreSQL connection refused
Root Cause: Database container not running
Suggested Fix: Start the postgres container or update connection config
Files to Modify: docker-compose.yaml
Confidence: high

Apply fix? [y/N] y

Applying fix...
✓ Fix applied (8s)

Running verification...
✓ npm run lint (1.2s)
✓ npm test (4.5s)
✓ http://localhost:3000/health (0.1s)

✓ Error #1 fixed successfully
```

### Autonomous Mode

```bash
$ selfheal watch --daemon --autonomous
Watcher started in background (autonomous mode)
PID: 12345

# Later, check logs:
$ selfheal logs --tail
[10:30:15] Error detected: #1 ConnectionError - ECONNREFUSED
[10:30:15] Auto-fixing error #1...
[10:30:16] Lock acquired for error #1
[10:30:30] Analysis complete (confidence: high)
[10:30:38] Fix applied
[10:30:45] Verification started
[10:30:52] Verification passed
[10:30:52] ✓ Error #1 fixed
[10:30:52] Lock released for error #1

$ selfheal status
Watcher: running since 2025-01-27T10:30:00Z (autonomous mode, up 15m)
PID: 12345

Pending: 0
Suggested (awaiting fix): 0
In progress: 0
Fixed today: 1
Failed: 0

# Manual fix blocked in autonomous mode:
$ selfheal fix 2
Error: Cannot run manual fix while daemon is in autonomous mode.
  The daemon will automatically fix errors.
  Run 'selfheal stop' first if you want manual control.
```

### Fix All

```bash
$ selfheal status
Watcher: not running

Pending: 3
Suggested (awaiting fix): 2
...

$ selfheal fix --all
Fixing 5 errors...

[1/5] Error #1: ConnectionError
      Analyzing... ✓
      Fixing... ✓
      Verifying... ✓
      ✓ Fixed

[2/5] Error #2: TypeError
      Analyzing... ✓
      Fixing... ✓
      Verifying... ✗ (npm test failed)
      ✖ Failed (attempt 1/3, will retry)

[3/5] Error #3: SyntaxError
      Already analyzed, applying fix...
      Fixing... ✓
      Verifying... ✓
      ✓ Fixed

[4/5] Error #4: ReferenceError
      Analyzing... ✓
      Fixing... ✓
      Verifying... ✓
      ✓ Fixed

[5/5] Error #5: ECONNREFUSED
      ⊘ Skipped (locked by another process)

Summary:
  Fixed: 3
  Failed: 1 (will retry on next run)
  Skipped: 1
```

### Context Cleanup

```bash
$ selfheal clean --dry-run
Would remove context files older than 7 days:
  2025-01-15-error-1-attempt-0-analyze.md
  2025-01-15-error-1-attempt-0-analysis.yaml
  2025-01-15-error-1-attempt-0-fix.md
  2025-01-15-error-1-attempt-0-result.yaml
  2025-01-18-error-3-attempt-0-analyze.md
  2025-01-18-error-3-attempt-0-analysis.yaml
  ... (17 more files)
Total: 23 files (1.2 MB)

Skipping (in-progress errors):
  (none)

$ selfheal clean
Remove 23 files (1.2 MB)? [y/N] y
Removed 23 files (1.2 MB)
```

---

## Build Configuration

```json
{
  "name": "selfheal",
  "version": "1.0.0",
  "type": "module",
  "bin": { "selfheal": "./dist/cli/index.js" },
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc",
    "test": "vitest",
    "lint": "eslint src test"
  },
  "engines": { "node": ">=18" }
}
```

---

## Dependencies

### Production

| Package | Purpose |
|---------|---------|
| commander | CLI framework |
| better-sqlite3 | SQLite database with sync API |
| chokidar | File watching |
| zod | Config validation |
| yaml | YAML parsing |

### Development

| Package | Purpose |
|---------|---------|
| typescript | Language |
| vitest | Testing |
| eslint | Linting |
| prettier | Formatting |
| @types/better-sqlite3 | Type definitions |
| @types/node | Type definitions |

---

## Future Enhancements

Not in scope for v1, but designed to accommodate:

| Feature | Notes |
|---------|-------|
| `--dry-run` | Show analysis without applying fix |
| Notifications | Webhook/Slack on error or fix |
| Web dashboard | Status UI in browser |
| Auto-commit | Commit fixes with descriptive message |
| PR mode | Create branch and PR instead of direct fix |
| Multiple projects | Single daemon watching multiple roots |
| Cooldown | Configurable wait between retry attempts |
| Error grouping | Group similar errors, fix once |
| Custom agents | Plugin system for additional AI providers |
| Windows daemon | Native Windows service support |
