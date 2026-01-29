import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSource } from '../../src/watcher/sources/file.js';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const createTempDir = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'watchfix-file-source-'));

const waitForLines = (
  source: FileSource,
  count: number,
  timeoutMs = 2000
): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const lines: string[] = [];
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${count} lines`));
    }, timeoutMs);

    source.on('line', (event) => {
      lines.push(event.line);
      if (lines.length === count) {
        clearTimeout(timer);
        resolve(lines);
      }
    });
  });

type TestLogger = {
  warnings: string[];
  warn: (message: string) => void;
  info: (message: string) => void;
  debug: (message: string) => void;
  error: (message: string) => void;
};

const createLogger = (): TestLogger => ({
  warnings: [],
  warn(message: string) {
    this.warnings.push(message);
  },
  info() {},
  debug() {},
  error() {},
});

describe('FileSource', () => {
  it('detects appended lines', async () => {
    const tempDir = createTempDir();
    const filePath = path.join(tempDir, 'app.log');
    fs.writeFileSync(filePath, '', 'utf8');

    const source = new FileSource({
      name: 'app',
      type: 'file',
      path: filePath,
    });

    try {
      await source.start();
      await delay(50);

      const linesPromise = waitForLines(source, 2);
      fs.appendFileSync(filePath, 'first\nsecond\n', 'utf8');

      const lines = await linesPromise;
      expect(lines).toEqual(['first', 'second']);
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('handles truncation by re-reading from start', async () => {
    const tempDir = createTempDir();
    const filePath = path.join(tempDir, 'app.log');
    fs.writeFileSync(filePath, '', 'utf8');

    const source = new FileSource({
      name: 'app',
      type: 'file',
      path: filePath,
    });

    try {
      await source.start();
      await delay(50);

      const firstLines = waitForLines(source, 1);
      fs.appendFileSync(filePath, 'one\n', 'utf8');
      await firstLines;

      fs.writeFileSync(filePath, '', 'utf8');
      await delay(50);

      const secondLines = waitForLines(source, 1);
      fs.appendFileSync(filePath, 'two\n', 'utf8');

      const [second] = await secondLines;
      expect(second).toBe('two');
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('waits for file creation and logs a warning', async () => {
    const tempDir = createTempDir();
    const filePath = path.join(tempDir, 'missing.log');
    const logger = createLogger();

    const source = new FileSource(
      {
        name: 'missing',
        type: 'file',
        path: filePath,
      },
      { logger }
    );

    try {
      await source.start();
      expect(logger.warnings.length).toBe(1);
      expect(logger.warnings[0]).toMatch(/not found/i);

      const linesPromise = waitForLines(source, 1);
      fs.writeFileSync(filePath, 'ready\n', 'utf8');

      const [line] = await linesPromise;
      expect(line).toBe('ready');
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
