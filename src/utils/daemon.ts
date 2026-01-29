import { spawn } from 'node:child_process';

import type { Database } from '../db/index.js';
import { logActivity } from '../db/queries.js';
import { LOCK_TIMEOUT_MS } from '../fixer/lock.js';
import { EXIT_CODES, InternalError, UserError } from './errors.js';
import type { Logger } from './logger.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;

export type CurrentFix = {
  promise: Promise<unknown>;
  abort: () => void;
};

export type DaemonOrchestrator = {
  stopWatchers?: () => void | Promise<void>;
  stop?: () => void | Promise<void>;
  getCurrentFix?: () => CurrentFix | null;
  releaseAllLocks?: () => Promise<void>;
};

type SetupSignalOptions = {
  logger?: Logger;
  db?: Database;
  clearWatcherState?: () => void;
  onShutdown?: () => void | Promise<void>;
};

function getForwardedArgs(): string[] {
  const argv = process.argv.slice(2);
  const filtered = argv.filter(
    (arg) => arg !== '--daemon' && arg !== '--daemon-child'
  );
  const watchIndex = filtered.indexOf('watch');
  if (watchIndex >= 0) {
    filtered.splice(watchIndex + 1, 0, '--daemon-child');
    return filtered;
  }
  return ['watch', '--daemon-child', ...filtered];
}

export function daemonize(): number {
  if (process.platform === 'win32') {
    throw new UserError(
      'Daemon mode is not supported on Windows.\n' +
        'Use foreground mode: watchfix watch --autonomous\n' +
        'Or use a process manager like PM2: pm2 start watchfix -- watch --autonomous'
    );
  }

  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new InternalError('Unable to resolve watchfix entrypoint.');
  }

  const args = getForwardedArgs();
  const child = spawn(process.execPath, [scriptPath, ...args], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    cwd: process.cwd(),
    env: { ...process.env, WATCHFIX_DAEMON: '1' },
  });

  child.unref();

  if (!child.pid) {
    throw new InternalError('Failed to spawn daemon process.');
  }

  return child.pid;
}

export function setupSignalHandlers(
  orchestrator: DaemonOrchestrator,
  options: SetupSignalOptions = {}
): void {
  let shuttingDown = false;
  const logger = options.logger;

  const logInfo = (message: string): void => {
    if (logger) {
      logger.info(message);
      return;
    }
    process.stderr.write(`${message}\n`);
  };

  const logWarn = (message: string): void => {
    if (logger) {
      logger.warn(message);
      return;
    }
    process.stderr.write(`${message}\n`);
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logInfo(`Received ${signal}, shutting down...`);

    const stopResult =
      orchestrator.stopWatchers?.() ?? orchestrator.stop?.();
    if (stopResult instanceof Promise) {
      await stopResult;
    }

    const currentFix = orchestrator.getCurrentFix?.() ?? null;
    if (currentFix) {
      logInfo('Waiting for current fix to complete...');
      let timeoutId: NodeJS.Timeout | null = null;
      try {
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          timeoutId = setTimeout(() => {
            logWarn('Fix did not complete in time, aborting');
            currentFix.abort();
            resolve('timeout');
          }, SHUTDOWN_TIMEOUT_MS);
        });
        const result = await Promise.race([
          currentFix.promise.then(() => 'completed' as const),
          timeoutPromise,
        ]);
        if (result === 'timeout') {
          logWarn('Continuing shutdown without waiting for fix completion');
        }
      } catch (error) {
        logWarn(
          `Current fix ended with error during shutdown: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    }

    if (orchestrator.releaseAllLocks) {
      await orchestrator.releaseAllLocks();
    }

    if (options.clearWatcherState) {
      options.clearWatcherState();
    }

    if (options.db) {
      logActivity(
        options.db,
        'watcher_stop',
        undefined,
        JSON.stringify({ signal, graceful: true })
      );
      options.db.close();
    }

    if (options.onShutdown) {
      await options.onShutdown();
    }

    logInfo('Shutdown complete');
    const exitCode =
      signal === 'SIGINT' ? EXIT_CODES.INTERRUPTED : EXIT_CODES.SUCCESS;
    process.exit(exitCode);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => {
      void shutdown('SIGHUP');
    });
  }
}

export function recoverStaleErrors(db: Database, logger?: Logger): void {
  const staleThreshold = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString();
  const now = new Date().toISOString();

  const result1 = db.run(
    `UPDATE errors
     SET status = 'pending', locked_by = NULL, locked_at = NULL, updated_at = ?
     WHERE status IN ('analyzing', 'fixing')
       AND locked_at < ?`,
    [now, staleThreshold]
  );

  const result2 = db.run(
    `UPDATE errors
     SET locked_by = NULL, locked_at = NULL, updated_at = ?
     WHERE status = 'suggested'
       AND locked_by IS NOT NULL
       AND locked_at < ?`,
    [now, staleThreshold]
  );

  const total = result1.changes + result2.changes;
  if (total > 0) {
    if (logger) {
      logger.warn(
        `Recovered ${result1.changes} stale error(s), cleared ${result2.changes} stale lock(s)`
      );
    }
    logActivity(
      db,
      'stale_recovery',
      undefined,
      JSON.stringify({ reset: result1.changes, unlocked: result2.changes })
    );
  }
}
