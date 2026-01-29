import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../../src/db/index.js';
import { initializeSchema } from '../../src/db/schema.js';
import {
  getError,
  getErrorByHash,
  getErrorsByStatus,
  getPendingErrors,
  insertError,
  logActivity,
  updateErrorStatus,
} from '../../src/db/queries.js';
import { createTempDir, removeTempDir } from '../helpers/test-utils.js';

type TempState = {
  dir: string;
  dbPath: string;
  db: Database;
};

let state: TempState | null = null;

const createDatabase = async (): Promise<TempState> => {
  const dir = await createTempDir('watchfix-db-');
  const dbPath = path.join(dir, '.watchfix', 'errors.db');
  const db = new Database(dbPath);
  initializeSchema(db);
  return { dir, dbPath, db };
};

beforeEach(async () => {
  state = await createDatabase();
});

afterEach(async () => {
  if (state) {
    state.db.close();
    await removeTempDir(state.dir);
    state = null;
  }
});

describe('Database integration', () => {
  it('initializes schema tables and version', () => {
    if (!state) {
      throw new Error('missing test state');
    }

    const tables = state.db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      .map((row) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'activity_log',
        'errors',
        'schema_version',
        'watcher_state',
      ])
    );

    const version = state.db.get<{ version: number }>(
      'SELECT version FROM schema_version LIMIT 1'
    );
    expect(version?.version).toBe(1);
  });

  it('performs CRUD operations on errors and activity log', () => {
    if (!state) {
      throw new Error('missing test state');
    }

    const timestamp = new Date('2026-01-01T12:00:00.000Z').toISOString();
    const id = insertError(state.db, {
      hash: 'hash-1',
      source: 'file:app.log',
      timestamp,
      errorType: 'TypeError',
      message: 'boom',
      rawLog: 'TypeError: boom',
    });

    expect(id).toBeGreaterThan(0);

    const record = getError(state.db, id);
    expect(record).not.toBeNull();
    expect(record?.hash).toBe('hash-1');
    expect(record?.status).toBe('pending');

    const byHash = getErrorByHash(state.db, 'hash-1');
    expect(byHash?.id).toBe(id);

    const pending = getPendingErrors(state.db);
    expect(pending.map((item) => item.id)).toContain(id);

    const updated = updateErrorStatus(state.db, id, 'fixed');
    expect(updated).toBe(true);

    const fixed = getErrorsByStatus(state.db, ['fixed']);
    expect(fixed.map((item) => item.id)).toContain(id);
    expect(getPendingErrors(state.db)).toHaveLength(0);

    logActivity(state.db, 'error_detected', id, 'first');
    const activity = state.db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM activity_log'
    );
    expect(activity?.count).toBe(1);
  });

  it('allows concurrent reads while a write transaction is open', () => {
    if (!state) {
      throw new Error('missing test state');
    }

    const id = insertError(state.db, {
      hash: 'hash-2',
      source: 'file:app.log',
      timestamp: new Date().toISOString(),
      errorType: 'ReferenceError',
      message: 'missing',
      rawLog: 'ReferenceError: missing',
    });

    state.db.exec('BEGIN IMMEDIATE');
    try {
      state.db.run('UPDATE errors SET message = ? WHERE id = ?', [
        'updated',
        id,
      ]);

      const reader = new Database(state.dbPath);
      try {
        const record = getError(reader, id);
        expect(record?.message).toBe('missing');
      } finally {
        reader.close();
      }
    } finally {
      state.db.exec('ROLLBACK');
    }
  });

  it('blocks concurrent writes while a write lock is held', () => {
    if (!state) {
      throw new Error('missing test state');
    }

    const id = insertError(state.db, {
      hash: 'hash-3',
      source: 'file:app.log',
      timestamp: new Date().toISOString(),
      errorType: 'RangeError',
      message: 'locked',
      rawLog: 'RangeError: locked',
    });

    const writer = new Database(state.dbPath);
    state.db.exec('BEGIN IMMEDIATE');
    const start = Date.now();
    let error: unknown;

    try {
      try {
        updateErrorStatus(writer, id, 'failed');
      } catch (err) {
        error = err;
      }

      expect(error).toBeTruthy();
      if (error && typeof error === 'object' && 'code' in error) {
        expect((error as { code?: string }).code).toBe('SQLITE_BUSY');
      }
      const message =
        error instanceof Error ? error.message : String(error ?? '');
      expect(message).toMatch(/locked/i);
      expect(Date.now() - start).toBeGreaterThanOrEqual(1000);
    } finally {
      state.db.exec('ROLLBACK');
      writer.close();
    }
  });
});
