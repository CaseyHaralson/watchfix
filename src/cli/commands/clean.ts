import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { loadConfig } from '../../config/loader.js';
import { Database } from '../../db/index.js';
import { getErrorsByStatus } from '../../db/queries.js';
import { checkSchemaVersion, initializeSchema } from '../../db/schema.js';
import { UserError } from '../../utils/errors.js';

type CleanOptions = {
  config?: string;
  dryRun?: boolean;
  force?: boolean;
  verbose?: boolean;
  quiet?: boolean;
};

type ContextFile = {
  filename: string;
  fullPath: string;
  relativePath: string;
  errorId: number;
  date: string;
  sizeBytes: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const buildDatabasePath = (rootDir: string): string =>
  path.join(rootDir, '.watchfix', 'errors.db');

const buildContextDir = (rootDir: string): string =>
  path.join(rootDir, '.watchfix', 'context');

const parseContextFilename = (
  filename: string
): { date: string; errorId: number } | null => {
  const match = filename.match(
    /^(\d{4}-\d{2}-\d{2})-error-(\d+)-attempt-\d+-/
  );
  if (!match) {
    return null;
  }
  const errorId = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isFinite(errorId)) {
    return null;
  }
  return { date: match[1], errorId };
};

const parseDatePrefix = (dateValue: string): number | null => {
  const parsed = Date.parse(`${dateValue}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
};

const formatSize = (bytes: number): string => {
  if (bytes <= 0) {
    return '0 B';
  }
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) {
    return `${mb.toFixed(1)} MB`;
  }
  const kb = bytes / 1024;
  return `${Math.max(1, Math.round(kb))} KB`;
};

const promptForConfirmation = async (label: string): Promise<boolean> => {
  if (!process.stdin.isTTY) {
    throw new UserError(
      'Cannot prompt for confirmation in non-interactive mode. Use --force to proceed.'
    );
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(`${label} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
};

const findInProgressErrorIds = (db: Database): Set<number> => {
  const inProgress = getErrorsByStatus(db, ['analyzing', 'fixing']);
  return new Set(inProgress.map((error) => error.id));
};

const loadContextFiles = (
  contextDir: string,
  rootDir: string
): ContextFile[] => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(contextDir, { withFileTypes: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return [];
    }
    throw new UserError(
      `Failed to read context directory ${contextDir}: ${err.message ?? String(err)}`
    );
  }

  const files: ContextFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const parsed = parseContextFilename(entry.name);
    if (!parsed) {
      continue;
    }
    const fullPath = path.join(contextDir, entry.name);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(fullPath);
    } catch {
      continue;
    }
    files.push({
      filename: entry.name,
      fullPath,
      relativePath: path.relative(rootDir, fullPath),
      errorId: parsed.errorId,
      date: parsed.date,
      sizeBytes: stats.size,
    });
  }

  return files;
};

const selectFilesToRemove = (
  files: ContextFile[],
  inProgress: Set<number>,
  maxAgeDays: number
): ContextFile[] => {
  const cutoffMs = Date.now() - maxAgeDays * DAY_MS;
  return files.filter((file) => {
    if (inProgress.has(file.errorId)) {
      return false;
    }
    const fileDate = parseDatePrefix(file.date);
    if (!fileDate) {
      return false;
    }
    return fileDate < cutoffMs;
  });
};

const summarizeRemoval = (files: ContextFile[]): string => {
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  return `${files.length} file${files.length === 1 ? '' : 's'} (${formatSize(totalBytes)})`;
};

const listFiles = (files: ContextFile[]): void => {
  for (const file of files) {
    process.stdout.write(`- ${file.relativePath}\n`);
  }
};

export const cleanCommand = async (options: CleanOptions): Promise<void> => {
  const config = loadConfig(options.config);
  const contextDir = buildContextDir(config.project.root);
  const dbPath = buildDatabasePath(config.project.root);

  const db = new Database(dbPath);
  let inProgress = new Set<number>();
  try {
    initializeSchema(db);
    checkSchemaVersion(db);
    inProgress = findInProgressErrorIds(db);
  } finally {
    db.close();
  }

  const allFiles = loadContextFiles(contextDir, config.project.root);
  const maxAgeDays = config.cleanup.context_max_age_days;
  const candidates = selectFilesToRemove(allFiles, inProgress, maxAgeDays);

  if (candidates.length === 0) {
    process.stdout.write(
      `No context files older than ${maxAgeDays} day${maxAgeDays === 1 ? '' : 's'} found.\n`
    );
    return;
  }

  process.stdout.write(
    `Context files older than ${maxAgeDays} day${maxAgeDays === 1 ? '' : 's'}:\n`
  );
  listFiles(candidates);

  if (options.dryRun) {
    process.stdout.write(`Would remove ${summarizeRemoval(candidates)}.\n`);
    return;
  }

  if (!options.force) {
    const confirmed = await promptForConfirmation(
      `Remove ${summarizeRemoval(candidates)}?`
    );
    if (!confirmed) {
      process.stdout.write('Cleanup aborted.\n');
      return;
    }
  }

  let removedCount = 0;
  let removedBytes = 0;
  for (const file of candidates) {
    try {
      fs.unlinkSync(file.fullPath);
      removedCount += 1;
      removedBytes += file.sizeBytes;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      throw new UserError(
        `Failed to remove ${file.relativePath}: ${err.message ?? String(err)}`
      );
    }
  }

  const removedSummary = `${removedCount} file${removedCount === 1 ? '' : 's'} (${formatSize(removedBytes)})`;
  process.stdout.write(`Removed ${removedSummary}.\n`);
};
