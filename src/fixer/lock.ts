import os from 'node:os';

import type { ErrorStatus } from '../utils/errors.js';
import type { Database } from '../db/index.js';
import { logActivity } from '../db/queries.js';

export const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

type LockRow = {
  locked_by: string | null;
  locked_at: string | null;
};

export function generateLockId(): string {
  return `${os.hostname()}:${process.pid}:${Date.now()}`;
}

export async function acquireLock(
  db: Database,
  errorId: number,
  lockId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const expiryThreshold = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString();

  const existing = db.get<LockRow>(
    'SELECT locked_by, locked_at FROM errors WHERE id = ?',
    [errorId]
  );

  const result = db.run(
    `UPDATE errors
     SET locked_by = ?, locked_at = ?, updated_at = ?
     WHERE id = ?
       AND (
         locked_by IS NULL
         OR locked_at < ?
       )`,
    [lockId, now, now, errorId, expiryThreshold]
  );

  if (result.changes === 0) {
    return false;
  }

  if (
    existing?.locked_by &&
    existing.locked_at &&
    existing.locked_at < expiryThreshold
  ) {
    logActivity(
      db,
      'lock_expired',
      errorId,
      JSON.stringify({
        previousLockId: existing.locked_by,
        acquiredBy: lockId,
      })
    );
  }

  logActivity(
    db,
    'lock_acquired',
    errorId,
    JSON.stringify({ lockId })
  );
  return true;
}

export async function releaseLock(
  db: Database,
  errorId: number,
  lockId: string
): Promise<void> {
  const result = db.run(
    `UPDATE errors
     SET locked_by = NULL, locked_at = NULL, updated_at = ?
     WHERE id = ? AND locked_by = ?`,
    [new Date().toISOString(), errorId, lockId]
  );

  if (result.changes > 0) {
    logActivity(
      db,
      'lock_released',
      errorId,
      JSON.stringify({ lockId })
    );
  }
}

export function transitionStatus(
  db: Database,
  errorId: number,
  expected: ErrorStatus | ErrorStatus[],
  newStatus: ErrorStatus,
  lockId: string
): boolean {
  const expectedStatuses = Array.isArray(expected) ? expected : [expected];
  const placeholders = expectedStatuses.map(() => '?').join(', ');

  const result = db.run(
    `UPDATE errors
     SET status = ?, updated_at = ?
     WHERE id = ?
       AND locked_by = ?
       AND status IN (${placeholders})`,
    [newStatus, new Date().toISOString(), errorId, lockId, ...expectedStatuses]
  );

  return result.changes > 0;
}
