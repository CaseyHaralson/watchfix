import path from 'node:path';

import { createAgent } from '../../agents/index.js';
import type { Agent } from '../../agents/types.js';
import { loadConfig } from '../../config/loader.js';
import { Database } from '../../db/index.js';
import { logActivity } from '../../db/queries.js';
import { initializeSchema, checkSchemaVersion } from '../../db/schema.js';
import { FixOrchestrator } from '../../fixer/index.js';
import { FixQueue } from '../../fixer/queue.js';
import { WatcherOrchestrator } from '../../watcher/index.js';
import {
  daemonize,
  recoverStaleErrors,
  setupSignalHandlers,
  type CurrentFix,
} from '../../utils/daemon.js';
import { parseDuration } from '../../utils/duration.js';
import { EXIT_CODES, UserError } from '../../utils/errors.js';
import { Logger, type Verbosity } from '../../utils/logger.js';
import { isOurProcess } from '../../utils/process.js';

type WatchOptions = {
  config?: string;
  verbose?: boolean;
  quiet?: boolean;
  daemon?: boolean;
  autonomous?: boolean;
  daemonChild?: boolean;
};

type WatcherStateRow = {
  pid: number;
  started_at: string;
  autonomous: number;
  project_root: string;
  command_line: string;
};

const resolveVerbosity = (options: WatchOptions): Verbosity => {
  if (options.quiet) {
    return 'quiet';
  }
  if (options.verbose) {
    return 'verbose';
  }
  return 'normal';
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

const ensureWatcherAvailable = (
  db: Database,
  projectRoot: string,
  logger?: Logger
): boolean => {
  const existing = getWatcherState(db);
  if (!existing) {
    return true;
  }

  if (isOurProcess(existing.pid, projectRoot)) {
    const mode = existing.autonomous ? 'autonomous' : 'manual';
    const message = `Watcher already running (pid ${existing.pid}, ${mode} mode). Use 'watchfix stop'.`;
    if (logger) {
      logger.error(message);
    } else {
      console.error(message);
    }
    process.exitCode = EXIT_CODES.WATCHER_CONFLICT;
    return false;
  }

  clearWatcherState(db);
  if (logger) {
    logger.warn('Cleared stale watcher state for non-running process.');
  }
  return true;
};

const insertWatcherState = (
  db: Database,
  options: { autonomous: boolean; projectRoot: string }
): void => {
  db.run(
    `INSERT OR REPLACE INTO watcher_state
     (id, pid, started_at, autonomous, project_root, command_line)
     VALUES (1, ?, ?, ?, ?, ?)`,
    [
      process.pid,
      new Date().toISOString(),
      options.autonomous ? 1 : 0,
      options.projectRoot,
      process.argv.join(' '),
    ]
  );
};

const validateDaemonChild = (options: WatchOptions): boolean => {
  const daemonChild = Boolean(options.daemonChild);
  const envDaemon = process.env.WATCHFIX_DAEMON === '1';

  if (daemonChild && !envDaemon) {
    throw new UserError(
      'The --daemon-child flag is internal. Use "watchfix watch --daemon" instead.'
    );
  }

  return daemonChild || envDaemon;
};

export const watchCommand = async (options: WatchOptions): Promise<void> => {
  const daemonChild = validateDaemonChild(options);

  if ((options.daemon || daemonChild) && process.platform === 'win32') {
    throw new UserError(
      'Daemon mode is not supported on Windows.\n' +
        'Use foreground mode: watchfix watch --autonomous\n' +
        'Or use a process manager like PM2: pm2 start watchfix -- watch --autonomous'
    );
  }

  const config = loadConfig(options.config);
  const verbosity = resolveVerbosity(options);

  if (options.daemon && !daemonChild) {
    const preflightLogger = new Logger({
      rootDir: config.project.root,
      terminalEnabled: true,
      verbosity,
    });
    createAgent(
      {
        provider: config.agent.provider,
        command: config.agent.command,
        args: config.agent.args,
        stderrIsProgress: config.agent.stderr_is_progress,
        timeout: parseDuration(config.agent.timeout),
        retries: config.agent.retries,
      },
      {
        projectRoot: config.project.root,
        logger: preflightLogger,
        terminalEnabled: true,
      }
    );

    const db = new Database(buildDatabasePath(config.project.root));
    initializeSchema(db);
    checkSchemaVersion(db);
    const available = ensureWatcherAvailable(db, config.project.root, preflightLogger);
    db.close();
    if (!available) {
      return;
    }

    const pid = daemonize();
    process.stdout.write(`Started watchfix daemon (pid ${pid}).\n`);
    return;
  }

  const terminalEnabled = !daemonChild;
  const logger = new Logger({
    rootDir: config.project.root,
    terminalEnabled,
    verbosity,
  });

  const agentConfig = {
    provider: config.agent.provider,
    command: config.agent.command,
    args: config.agent.args,
    stderrIsProgress: config.agent.stderr_is_progress,
    timeout: parseDuration(config.agent.timeout),
    retries: config.agent.retries,
  };
  const agentOptions = {
    projectRoot: config.project.root,
    logger,
    terminalEnabled,
  };

  let agent: Agent | undefined;
  if (options.autonomous) {
    agent = createAgent(agentConfig, agentOptions);
  } else {
    createAgent(agentConfig, agentOptions);
  }

  const db = new Database(buildDatabasePath(config.project.root));
  initializeSchema(db);
  checkSchemaVersion(db);

  const available = ensureWatcherAvailable(db, config.project.root, logger);
  if (!available) {
    db.close();
    return;
  }

  recoverStaleErrors(db, logger);

  insertWatcherState(db, {
    autonomous: Boolean(options.autonomous),
    projectRoot: config.project.root,
  });

  logActivity(
    db,
    'watcher_start',
    undefined,
    JSON.stringify({
      pid: process.pid,
      autonomous: Boolean(options.autonomous),
      daemon: daemonChild,
    })
  );

  const watcher = new WatcherOrchestrator(config, db, { logger });

  let fixQueue: FixQueue | null = null;
  let currentFix: CurrentFix | null = null;

  if (options.autonomous) {
    const fixOrchestrator = new FixOrchestrator(db, config, {
      agent,
      logger,
      terminalEnabled,
    });
    fixQueue = new FixQueue(db, {
      onProcess: async (error) => {
        const errorId = error.id;
        const fixPromise = fixOrchestrator.fixError(errorId);
        currentFix = {
          promise: fixPromise,
          abort: () => {
            logger.warn('Fix abort requested but not supported for current agent.');
          },
        };
        try {
          await fixPromise;
        } catch (cause) {
          logger.error(
            `Fix pipeline failed for error ${errorId}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`
          );
        } finally {
          currentFix = null;
        }
      },
    });

    watcher.on('error_detected', () => {
      void fixQueue?.processQueueIfReady();
    });
  }

  process.removeAllListeners('SIGINT');
  setupSignalHandlers(
    {
      stopWatchers: async () => {
        await watcher.stop();
      },
      getCurrentFix: () => currentFix,
    },
    {
      logger,
      db,
      clearWatcherState: () => clearWatcherState(db),
    }
  );

  await watcher.start();
  logger.info('Watching for errors... (Ctrl+C to stop)');

  if (options.autonomous) {
    void fixQueue?.processQueueIfReady();
  }

  await new Promise<void>(() => {});
};
