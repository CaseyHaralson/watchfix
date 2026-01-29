import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger } from '../../src/utils/logger.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'watchfix-logger-'));
}

function readLogLines(logPath: string): string[] {
  const content = fs.readFileSync(logPath, 'utf8');
  return content.trim().split('\n');
}

describe('Logger', () => {
  it('writes logs with the correct format', () => {
    const rootDir = createTempDir();
    const logger = new Logger({ rootDir, terminalEnabled: false });

    logger.info('Hello world');

    const logPath = path.join(rootDir, '.watchfix', 'daemon.log');
    const [line] = readLogLines(logPath);

    expect(line).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] Hello world$/,
    );
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('filters logs based on verbosity', () => {
    const rootDir = createTempDir();
    const logger = new Logger({
      rootDir,
      terminalEnabled: false,
      verbosity: 'quiet',
    });

    logger.info('Hidden');
    logger.warn('Visible');

    const logPath = path.join(rootDir, '.watchfix', 'daemon.log');
    const lines = readLogLines(logPath);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\[WARN\] Visible$/);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('shows debug logs in verbose mode', () => {
    const rootDir = createTempDir();
    const logger = new Logger({
      rootDir,
      terminalEnabled: false,
      verbosity: 'verbose',
    });

    logger.debug('Debug message');
    logger.info('Info message');

    const logPath = path.join(rootDir, '.watchfix', 'daemon.log');
    const lines = readLogLines(logPath);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\[DEBUG\] Debug message$/);
    expect(lines[1]).toMatch(/\[INFO\] Info message$/);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
