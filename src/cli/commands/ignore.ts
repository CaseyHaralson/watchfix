import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config/loader.js';
import { Database } from '../../db/index.js';
import { getError, logActivity, type ErrorRecord } from '../../db/queries.js';
import { checkSchemaVersion, initializeSchema } from '../../db/schema.js';
import { acquireLock, generateLockId, releaseLock, transitionStatus } from '../../fixer/lock.js';
import { EXIT_CODES, type ErrorStatus, UserError } from '../../utils/errors.js';

type IgnoreOptions = {
  config?: string;
  verbose?: boolean;
  quiet?: boolean;
};

const IGNORABLE_STATUSES: ErrorStatus[] = ['pending', 'suggested', 'failed'];

const buildDatabasePath = (rootDir: string): string =>
  path.join(rootDir, '.watchfix', 'errors.db');

const parsePositiveInt = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UserError('Error id must be a positive integer.');
  }
  return parsed;
};

const ensureIgnorable = (error: ErrorRecord): string | null => {
  if (IGNORABLE_STATUSES.includes(error.status)) {
    return null;
  }
  if (error.status === 'analyzing' || error.status === 'fixing') {
    return `Error #${error.id} is currently ${error.status}.`;
  }
  return `Error #${error.id} is not in an ignorable state (status=${error.status}).`;
};

export const ignoreCommand = async (
  id: string,
  options: IgnoreOptions
): Promise<void> => {
  const errorId = parsePositiveInt(id);
  const config = loadConfig(options.config);
  const dbPath = buildDatabasePath(config.project.root);

  if (!fs.existsSync(dbPath)) {
    throw new UserError(
      `No database found at ${dbPath}. Run watchfix watch to create it.`
    );
  }

  const db = new Database(dbPath);
  try {
    initializeSchema(db);
    checkSchemaVersion(db);

    const error = getError(db, errorId);
    if (!error) {
      console.error(`Error #${errorId} not found.`);
      process.exitCode = EXIT_CODES.NOT_ACTIONABLE;
      return;
    }

    const ignorableIssue = ensureIgnorable(error);
    if (ignorableIssue) {
      console.error(ignorableIssue);
      process.exitCode = EXIT_CODES.NOT_ACTIONABLE;
      return;
    }

    const lockId = generateLockId();
    const lockAcquired = await acquireLock(db, errorId, lockId);
    if (!lockAcquired) {
      console.error(`Error #${errorId} is locked by another process.`);
      process.exitCode = EXIT_CODES.NOT_ACTIONABLE;
      return;
    }

    try {
      const updated = transitionStatus(
        db,
        errorId,
        IGNORABLE_STATUSES,
        'ignored',
        lockId
      );

      if (!updated) {
        console.error(
          `Error #${errorId} could not be ignored because it changed state.`
        );
        process.exitCode = EXIT_CODES.NOT_ACTIONABLE;
        return;
      }

      logActivity(db, 'error_ignored', errorId);
      process.stdout.write(`Ignored error #${errorId}.\n`);
    } finally {
      await releaseLock(db, errorId, lockId);
    }
  } finally {
    db.close();
  }
};
