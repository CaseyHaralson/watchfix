# Concurrency and Locking

## Problem

Multiple processes may try to fix the same error:
- Daemon running in autonomous mode
- User running `watchfix fix <id>`
- Multiple terminal sessions

## Solution: Optimistic Locking

Each error can be locked by a single process.

### Lock Identifier

```typescript
// Format: hostname:pid:timestamp
function generateLockId(): string {
  return `${os.hostname()}:${process.pid}:${Date.now()}`;
}
```

### Lock Timeout

```typescript
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
```

Locks expire after 10 minutes to handle crashed processes.

### Acquiring a Lock

```typescript
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
    return false; // Lock not acquired
  }

  logActivity('lock_acquired', errorId, { lockId });
  return true;
}
```

### Releasing a Lock

```typescript
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

  return result.changes > 0;
}
```

## Lock Lifecycle

- **Acquired**: Start of analysis (for `pending`) or start of fix (for `suggested`)
- **Held through**: Analysis → suggested → fix → verification
- **Released when**: Status becomes `fixed`, `failed`, or `ignored`
- **Released when**: `--analyze-only` flag used and analysis completes successfully
- **Released early if**: Verification fails and error returns to `pending` for retry

## Stale Status Recovery

On watcher startup, recover orphaned errors:

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

  if (result1.changes + result2.changes > 0) {
    logActivity('stale_recovery', null, {
      reset: result1.changes,
      unlocked: result2.changes
    });
  }
}
```

Call `recoverStaleErrors()` at daemon startup before starting watchers.
