import type { ErrorStatus } from '../utils/errors.js';
import type { Database } from './index.js';

export type ErrorRecord = {
  id: number;
  hash: string;
  source: string;
  timestamp: string;
  errorType: string;
  message: string;
  stackTrace: string | null;
  rawLog: string;
  status: ErrorStatus;
  suggestion: string | null;
  fixResult: string | null;
  fixAttempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ErrorInsert = {
  hash: string;
  source: string;
  timestamp: string;
  errorType: string;
  message: string;
  stackTrace?: string | null;
  rawLog: string;
  status?: ErrorStatus;
  suggestion?: string | null;
  fixResult?: string | null;
  fixAttempts?: number;
  lockedBy?: string | null;
  lockedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type ActivityAction =
  | 'watcher_start'
  | 'watcher_stop'
  | 'error_detected'
  | 'error_deduplicated'
  | 'analysis_start'
  | 'analysis_complete'
  | 'analysis_failed'
  | 'analysis_timeout'
  | 'already_fixed_detected'
  | 'fix_start'
  | 'fix_complete'
  | 'fix_failed'
  | 'fix_timeout'
  | 'verification_start'
  | 'verification_pass'
  | 'verification_fail'
  | 'error_ignored'
  | 'lock_acquired'
  | 'lock_released'
  | 'lock_expired'
  | 'stale_recovery';

type ErrorRow = {
  id: number;
  hash: string;
  source: string;
  timestamp: string;
  error_type: string;
  message: string;
  stack_trace: string | null;
  raw_log: string;
  status: ErrorStatus;
  suggestion: string | null;
  fix_result: string | null;
  fix_attempts: number;
  locked_by: string | null;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
};

function mapErrorRow(row: ErrorRow): ErrorRecord {
  return {
    id: row.id,
    hash: row.hash,
    source: row.source,
    timestamp: row.timestamp,
    errorType: row.error_type,
    message: row.message,
    stackTrace: row.stack_trace,
    rawLog: row.raw_log,
    status: row.status,
    suggestion: row.suggestion,
    fixResult: row.fix_result,
    fixAttempts: row.fix_attempts,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ERROR_SELECT_COLUMNS = `
  id,
  hash,
  source,
  timestamp,
  error_type,
  message,
  stack_trace,
  raw_log,
  status,
  suggestion,
  fix_result,
  fix_attempts,
  locked_by,
  locked_at,
  created_at,
  updated_at
`;

export function insertError(db: Database, error: ErrorInsert): number {
  const now = new Date().toISOString();
  const createdAt = error.createdAt ?? now;
  const updatedAt = error.updatedAt ?? createdAt;
  const status = error.status ?? 'pending';
  const fixAttempts = error.fixAttempts ?? 0;

  const result = db.run(
    `INSERT INTO errors (
      hash,
      source,
      timestamp,
      error_type,
      message,
      stack_trace,
      raw_log,
      status,
      suggestion,
      fix_result,
      fix_attempts,
      locked_by,
      locked_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      error.hash,
      error.source,
      error.timestamp,
      error.errorType,
      error.message,
      error.stackTrace ?? null,
      error.rawLog,
      status,
      error.suggestion ?? null,
      error.fixResult ?? null,
      fixAttempts,
      error.lockedBy ?? null,
      error.lockedAt ?? null,
      createdAt,
      updatedAt,
    ]
  );

  return Number(result.lastInsertRowid);
}

export function getError(db: Database, id: number): ErrorRecord | null {
  const row = db.get<ErrorRow>(
    `SELECT ${ERROR_SELECT_COLUMNS} FROM errors WHERE id = ?`,
    [id]
  );
  if (!row) {
    return null;
  }
  return mapErrorRow(row);
}

export function getErrorByHash(db: Database, hash: string): ErrorRecord | null {
  const row = db.get<ErrorRow>(
    `SELECT ${ERROR_SELECT_COLUMNS} FROM errors WHERE hash = ? ORDER BY created_at DESC LIMIT 1`,
    [hash]
  );
  if (!row) {
    return null;
  }
  return mapErrorRow(row);
}

export function updateErrorStatus(
  db: Database,
  id: number,
  status: ErrorStatus
): boolean {
  const result = db.run(
    'UPDATE errors SET status = ?, updated_at = ? WHERE id = ?',
    [status, new Date().toISOString(), id]
  );
  return result.changes > 0;
}

export function getErrorsByStatus(
  db: Database,
  statuses: ErrorStatus[]
): ErrorRecord[] {
  if (statuses.length === 0) {
    return [];
  }

  const placeholders = statuses.map(() => '?').join(', ');
  const rows = db.all<ErrorRow>(
    `SELECT ${ERROR_SELECT_COLUMNS} FROM errors WHERE status IN (${placeholders}) ORDER BY created_at ASC`,
    statuses
  );

  return rows.map(mapErrorRow);
}

export function getPendingErrors(db: Database): ErrorRecord[] {
  return getErrorsByStatus(db, ['pending']);
}

export function logActivity(
  db: Database,
  action: ActivityAction,
  errorId?: number,
  details?: string
): void {
  db.run(
    'INSERT INTO activity_log (timestamp, action, error_id, details) VALUES (?, ?, ?, ?)',
    [new Date().toISOString(), action, errorId ?? null, details ?? null]
  );
}
