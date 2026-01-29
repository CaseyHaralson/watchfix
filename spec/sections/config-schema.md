# Configuration Schema

## Path Resolution

All relative paths in `watchfix.yaml` are resolved relative to the directory containing the config file. When using `--config` to specify an alternate location, paths are still relative to that config file's directory, not the current working directory.

## Duration Strings

Duration values use a simple format with supported units:
- `s` - seconds (e.g., `30s`)
- `m` - minutes (e.g., `5m`)
- `h` - hours (e.g., `1h`)

Examples: `5s`, `10m`, `1h`, `90s`

## Complete Schema

```yaml
# watchfix.yaml

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

## Zod Schema

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

## Validation

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
