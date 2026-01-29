import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { Database } from '../../src/db/index.js';
import { initializeSchema } from '../../src/db/schema.js';
import { getError, insertError } from '../../src/db/queries.js';
import {
  LOCK_TIMEOUT_MS,
  acquireLock,
  generateLockId,
  releaseLock,
  transitionStatus,
} from '../../src/fixer/lock.js';

function createDb(): Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function insertSampleError(db: Database): number {
  return insertError(db, {
    hash: 'hash-1',
    source: 'unit-test',
    timestamp: new Date().toISOString(),
    errorType: 'TypeError',
    message: 'Boom',
    rawLog: 'Trace',
  });
}

function getActions(db: Database, errorId: number): string[] {
  const rows = db.all<{ action: string }>(
    'SELECT action FROM activity_log WHERE error_id = ? ORDER BY id',
    [errorId]
  );
  return rows.map((row) => row.action);
}

describe('lock utilities', () => {
  it('generates lock ids with hostname and pid', () => {
    const lockId = generateLockId();
    const [host, pid, timestamp] = lockId.split(':');

    expect(host).toBe(os.hostname());
    expect(Number(pid)).toBe(process.pid);
    expect(Number(timestamp)).toBeGreaterThan(0);
  });

  it('acquires and releases locks', async () => {
    const db = createDb();
    const errorId = insertSampleError(db);
    const lockId = 'lock-a';

    const acquired = await acquireLock(db, errorId, lockId);
    expect(acquired).toBe(true);

    const record = getError(db, errorId);
    expect(record?.lockedBy).toBe(lockId);
    expect(record?.lockedAt).not.toBeNull();

    await releaseLock(db, errorId, lockId);
    const released = getError(db, errorId);
    expect(released?.lockedBy).toBeNull();
    expect(released?.lockedAt).toBeNull();

    expect(getActions(db, errorId)).toEqual(['lock_acquired', 'lock_released']);
    db.close();
  });

  it('rejects lock acquisition when already locked', async () => {
    const db = createDb();
    const errorId = insertSampleError(db);
    const now = new Date().toISOString();

    db.run('UPDATE errors SET locked_by = ?, locked_at = ? WHERE id = ?', [
      'lock-a',
      now,
      errorId,
    ]);

    const acquired = await acquireLock(db, errorId, 'lock-b');
    expect(acquired).toBe(false);

    const record = getError(db, errorId);
    expect(record?.lockedBy).toBe('lock-a');
    expect(getActions(db, errorId)).toEqual([]);
    db.close();
  });

  it('reclaims expired locks and records expiration', async () => {
    const db = createDb();
    const errorId = insertSampleError(db);
    const expiredAt = new Date(Date.now() - LOCK_TIMEOUT_MS - 1000).toISOString();

    db.run('UPDATE errors SET locked_by = ?, locked_at = ? WHERE id = ?', [
      'old-lock',
      expiredAt,
      errorId,
    ]);

    const acquired = await acquireLock(db, errorId, 'new-lock');
    expect(acquired).toBe(true);

    const actions = getActions(db, errorId);
    expect(actions).toEqual(['lock_expired', 'lock_acquired']);
    db.close();
  });

  it('transitions status only when lock and expected status match', async () => {
    const db = createDb();
    const errorId = insertSampleError(db);

    await acquireLock(db, errorId, 'lock-a');

    const transitioned = transitionStatus(
      db,
      errorId,
      'pending',
      'analyzing',
      'lock-a'
    );
    expect(transitioned).toBe(true);

    const record = getError(db, errorId);
    expect(record?.status).toBe('analyzing');

    const failsOnStatus = transitionStatus(
      db,
      errorId,
      'pending',
      'fixing',
      'lock-a'
    );
    expect(failsOnStatus).toBe(false);

    const failsOnLock = transitionStatus(
      db,
      errorId,
      'analyzing',
      'fixing',
      'lock-b'
    );
    expect(failsOnLock).toBe(false);
    db.close();
  });
});
