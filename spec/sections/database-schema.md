# Database Schema

## Configuration

SQLite database at `.selfheal/errors.db`:

```typescript
const db = new Database('.selfheal/errors.db');
db.pragma('journal_mode = WAL');      // Write-ahead logging for concurrent reads
db.pragma('busy_timeout = 5000');     // Wait up to 5s for locks
db.pragma('synchronous = NORMAL');    // Balance durability and performance
```

## Schema Version

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

For v1: Single schema version (1). On version mismatch, exit with code 4.

## errors Table

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

## watcher_state Table

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

## activity_log Table

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

## Activity Log Actions

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
