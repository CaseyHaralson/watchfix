import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config/loader.js';
import { UserError } from '../../utils/errors.js';
import { DEFAULT_LOG_PATH } from '../../utils/logger.js';

type LogsOptions = {
  config?: string;
  lines?: string | number;
  tail?: boolean;
  verbose?: boolean;
  quiet?: boolean;
};

const DEFAULT_LINES = 50;

const parseLineCount = (value?: string | number): number => {
  if (value === undefined) {
    return DEFAULT_LINES;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new UserError('Line count must be a positive integer.');
    }
    return value;
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new UserError('Line count must be a positive integer.');
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UserError('Line count must be a positive integer.');
  }
  return parsed;
};

const resolveLogPath = (configPath?: string): string => {
  const config = loadConfig(configPath);
  return path.join(config.project.root, DEFAULT_LOG_PATH);
};

const readLogLines = (logPath: string): string[] => {
  const contents = fs.readFileSync(logPath, 'utf8');
  const lines = contents.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
};

const outputLastLines = (logPath: string, lineCount: number): void => {
  const lines = readLogLines(logPath);
  const startIndex = Math.max(0, lines.length - lineCount);
  const output = lines.slice(startIndex);
  if (output.length === 0) {
    return;
  }
  process.stdout.write(`${output.join('\n')}\n`);
};

const readNewEntries = (logPath: string, start: number): number => {
  const stats = fs.statSync(logPath);
  if (stats.size < start) {
    return 0;
  }
  if (stats.size === start) {
    return start;
  }
  const length = stats.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(logPath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  process.stdout.write(buffer.toString('utf8'));
  return stats.size;
};

const tailLog = (logPath: string): void => {
  let position = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const watchDir = path.dirname(logPath);
  const fileName = path.basename(logPath);

  const watcher = fs.watch(
    watchDir,
    { persistent: true },
    (event, changed) => {
      if (changed && changed !== fileName) {
        return;
      }
      if (event === 'rename' && !fs.existsSync(logPath)) {
        position = 0;
        return;
      }
      try {
        position = readNewEntries(logPath, position);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          position = 0;
          return;
        }
        throw error;
      }
    }
  );

  process.on('SIGINT', () => {
    watcher.close();
  });
};

export const logsCommand = async (options: LogsOptions): Promise<void> => {
  const logPath = resolveLogPath(options.config);
  if (!fs.existsSync(logPath)) {
    throw new UserError(
      `No log file found at ${logPath}. Start watchfix watch to create it.`
    );
  }

  const lineCount = parseLineCount(options.lines);
  outputLastLines(logPath, lineCount);

  if (options.tail) {
    tailLog(logPath);
  }
};
