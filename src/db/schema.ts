import { EXIT_CODES } from '../utils/errors.js';
import type { Database } from './index.js';

export const SCHEMA_VERSION = 1;

const CREATE_ERRORS_TABLE = `
CREATE TABLE IF NOT EXISTS errors (
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

CREATE INDEX IF NOT EXISTS idx_errors_hash ON errors(hash);
CREATE INDEX IF NOT EXISTS idx_errors_status ON errors(status);
CREATE INDEX IF NOT EXISTS idx_errors_created_at ON errors(created_at);
`;

const CREATE_WATCHER_STATE_TABLE = `
CREATE TABLE IF NOT EXISTS watcher_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  autonomous INTEGER NOT NULL DEFAULT 0,
  project_root TEXT NOT NULL,
  command_line TEXT NOT NULL
);
`;

const CREATE_ACTIVITY_LOG_TABLE = `
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL,
  error_id INTEGER,
  details TEXT,
  FOREIGN KEY (error_id) REFERENCES errors(id)
);

CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON activity_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_activity_log_error_id ON activity_log(error_id);
`;

const CREATE_SCHEMA_VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

export function initializeSchema(db: Database): void {
  db.exec('BEGIN');
  try {
    db.exec(CREATE_SCHEMA_VERSION_TABLE);
    db.exec(CREATE_ERRORS_TABLE);
    db.exec(CREATE_WATCHER_STATE_TABLE);
    db.exec(CREATE_ACTIVITY_LOG_TABLE);

    const existing = db.get<{ version: number }>(
      'SELECT version FROM schema_version LIMIT 1'
    );
    if (!existing) {
      db.run('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', [
        SCHEMA_VERSION,
        new Date().toISOString(),
      ]);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function checkSchemaVersion(db: Database): void {
  const row = db.get<{ version: number }>(
    'SELECT version FROM schema_version LIMIT 1'
  );
  if (!row || row.version !== SCHEMA_VERSION) {
    const found = row ? String(row.version) : 'none';
    console.error(
      `Database schema version mismatch. Expected ${SCHEMA_VERSION}, found ${found}.`
    );
    process.exit(EXIT_CODES.SCHEMA_MISMATCH);
  }
}
