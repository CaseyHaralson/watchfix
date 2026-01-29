# Logging

## Log File

All watcher activity logged to `.selfheal/daemon.log`.

## Format

```
{ISO8601 timestamp} [{LEVEL}] {message}
```

Example:
```
2025-01-27T10:30:00.000Z [INFO] Watcher started (autonomous=false)
2025-01-27T10:30:01.000Z [INFO] Watching: backend (file: ./logs/backend.log)
2025-01-27T10:30:02.000Z [WARN] Log file not found: ./logs/api.log - waiting for creation
2025-01-27T10:30:15.000Z [INFO] Error detected: #1 ConnectionError - ECONNREFUSED 127.0.0.1:5432
```

## Log Levels

| Level | Description |
|-------|-------------|
| `DEBUG` | Detailed diagnostic info (lock operations, state transitions) |
| `INFO` | Normal operational messages (errors detected, fixes applied) |
| `WARN` | Potential issues (file not found, retries, timeouts) |
| `ERROR` | Failures requiring attention (agent failures, verification failures) |

## Terminal Output

- **Foreground mode:** Logs written to both file and terminal (stderr)
- **Daemon mode:** Logs written to file only

## Verbosity Control

| Flag | DEBUG | INFO | WARN | ERROR |
|------|-------|------|------|-------|
| `--quiet`, `-q` | ✗ | ✗ | ✓ | ✓ |
| (default) | ✗ | ✓ | ✓ | ✓ |
| `--verbose` | ✓ | ✓ | ✓ | ✓ |

## Log Rotation

Built-in rotation based on file size:

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

Result:
```
.selfheal/
├── daemon.log        # Current (< 10MB)
├── daemon.log.1      # Previous
├── daemon.log.2
├── daemon.log.3
├── daemon.log.4
└── daemon.log.5      # Oldest (deleted on next rotation)
```
