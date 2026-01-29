import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config/loader.js';
import { Database } from '../../db/index.js';
import { checkSchemaVersion, initializeSchema } from '../../db/schema.js';
import { EXIT_CODES, UserError } from '../../utils/errors.js';
import { isOurProcess } from '../../utils/process.js';

type StopOptions = {
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

const buildDatabasePath = (rootDir: string): string =>
  path.join(rootDir, '.watchfix', 'errors.db');

const getWatcherState = (db: Database): WatcherStateRow | undefined =>
  db.get<WatcherStateRow>(
    'SELECT pid, started_at, autonomous, project_root, command_line FROM watcher_state WHERE id = 1'
  );

const clearWatcherState = (db: Database): void => {
  db.run('DELETE FROM watcher_state WHERE id = 1');
};

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForProcessExit = async (
  pid: number,
  timeoutMs: number
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await sleep(500);
  }
  return !isProcessRunning(pid);
};

const formatKillError = (pid: number, signal: string, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to send ${signal} to watcher (pid ${pid}): ${message}`;
};

const isNoSuchProcessError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }
  return (error as NodeJS.ErrnoException).code === 'ESRCH';
};

export const stopCommand = async (options: StopOptions): Promise<void> => {
  const config = loadConfig(options.config);
  const dbPath = buildDatabasePath(config.project.root);

  if (!fs.existsSync(dbPath)) {
    process.stdout.write('No watcher running.\n');
    process.exitCode = EXIT_CODES.WATCHER_CONFLICT;
    return;
  }

  const db = new Database(dbPath);
  try {
    initializeSchema(db);
    checkSchemaVersion(db);

    const state = getWatcherState(db);
    if (!state) {
      process.stdout.write('No watcher running.\n');
      process.exitCode = EXIT_CODES.WATCHER_CONFLICT;
      return;
    }

    if (!isOurProcess(state.pid, state.project_root)) {
      process.stdout.write('Stale watcher state (process no longer exists).\n');
      clearWatcherState(db);
      process.exitCode = EXIT_CODES.WATCHER_CONFLICT;
      return;
    }

    process.stdout.write(`Stopping watcher (PID ${state.pid})...\n`);

    try {
      process.kill(state.pid, 'SIGTERM');
    } catch (error) {
      if (isNoSuchProcessError(error)) {
        process.stdout.write('Stale watcher state (process already exited).\n');
        clearWatcherState(db);
        process.exitCode = EXIT_CODES.WATCHER_CONFLICT;
        return;
      }
      throw new UserError(formatKillError(state.pid, 'SIGTERM', error));
    }

    const stopped = await waitForProcessExit(state.pid, 30_000);
    if (!stopped) {
      process.stdout.write('Watcher did not stop gracefully, forcing...\n');
      try {
        process.kill(state.pid, 'SIGKILL');
      } catch (error) {
        if (isNoSuchProcessError(error)) {
          process.stdout.write('Stale watcher state (process already exited).\n');
          clearWatcherState(db);
          process.exitCode = EXIT_CODES.WATCHER_CONFLICT;
          return;
        }
        throw new UserError(formatKillError(state.pid, 'SIGKILL', error));
      }
      const killed = await waitForProcessExit(state.pid, 5000);
      if (!killed) {
        throw new UserError(
          `Watcher did not stop after SIGKILL (pid ${state.pid}).`
        );
      }
    }

    clearWatcherState(db);
    process.stdout.write('Watcher stopped.\n');
  } finally {
    db.close();
  }
};
