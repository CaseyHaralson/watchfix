import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config/loader.js';
import { Database } from '../../db/index.js';
import { getErrorsByStatus, type ErrorRecord } from '../../db/queries.js';
import { checkSchemaVersion, initializeSchema } from '../../db/schema.js';
import type { ErrorStatus } from '../../utils/errors.js';
import { isOurProcess } from '../../utils/process.js';

type StatusOptions = {
  config?: string;
  verbose?: boolean;
  quiet?: boolean;
};

type WatcherStateRow = {
  pid: number;
  started_at: string;
  autonomous: number;
  project_root: string;
  command_line: string;
};

const STATUS_ORDER: ErrorStatus[] = [
  'pending',
  'analyzing',
  'suggested',
  'fixing',
  'fixed',
  'failed',
  'ignored',
];

const buildDatabasePath = (rootDir: string): string =>
  path.join(rootDir, '.watchfix', 'errors.db');

const getWatcherState = (db: Database): WatcherStateRow | undefined =>
  db.get<WatcherStateRow>(
    'SELECT pid, started_at, autonomous, project_root, command_line FROM watcher_state WHERE id = 1'
  );

const clearWatcherState = (db: Database): void => {
  db.run('DELETE FROM watcher_state WHERE id = 1');
};

const formatUptime = (startedAt: string): string => {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) {
    return 'unknown';
  }
  const diffMs = Date.now() - startedMs;
  if (diffMs < 0) {
    return 'unknown';
  }
  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(' ');
};

const loadStatusCounts = (db: Database): Record<ErrorStatus, number> => {
  const counts = Object.fromEntries(
    STATUS_ORDER.map((status) => [status, 0])
  ) as Record<ErrorStatus, number>;

  const rows = db.all<{ status: ErrorStatus; count: number }>(
    'SELECT status, COUNT(*) as count FROM errors GROUP BY status'
  );
  for (const row of rows) {
    if (row.status in counts) {
      counts[row.status] = row.count;
    }
  }
  return counts;
};

const formatActionableErrors = (errors: ErrorRecord[]): string[] => {
  if (errors.length === 0) {
    return ['Actionable errors: none'];
  }

  const lines = ['Actionable errors:'];
  for (const error of errors) {
    lines.push(
      `  #${error.id} ${error.errorType} (${error.source}): ${error.message}`
    );
  }
  return lines;
};

export const statusCommand = async (options: StatusOptions): Promise<void> => {
  const config = loadConfig(options.config);
  const dbPath = buildDatabasePath(config.project.root);

  if (!fs.existsSync(dbPath)) {
    const lines = [
      'Watcher: not running.',
      'Errors:',
      ...STATUS_ORDER.map((status) => `  ${status}: 0`),
      'Actionable errors: none',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  const db = new Database(dbPath);
  try {
    initializeSchema(db);
    checkSchemaVersion(db);

    const lines: string[] = [];
    const state = getWatcherState(db);

    if (state && isOurProcess(state.pid, state.project_root)) {
      const mode = state.autonomous ? 'autonomous' : 'manual';
      const uptime = formatUptime(state.started_at);
      lines.push(
        `Watcher: running (pid ${state.pid}, ${mode} mode, uptime ${uptime}).`
      );
    } else {
      if (state) {
        clearWatcherState(db);
        lines.push('Watcher: not running (cleared stale state).');
      } else {
        lines.push('Watcher: not running.');
      }
    }

    const counts = loadStatusCounts(db);
    lines.push('Errors:');
    for (const status of STATUS_ORDER) {
      lines.push(`  ${status}: ${counts[status]}`);
    }

    const actionable = getErrorsByStatus(db, ['pending', 'suggested']);
    lines.push(...formatActionableErrors(actionable));

    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    db.close();
  }
};
