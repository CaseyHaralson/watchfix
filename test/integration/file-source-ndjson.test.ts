import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSource } from '../../src/watcher/sources/file.js';
import type { LogEvent } from '../../src/watcher/sources/types.js';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const createTempDir = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'watchfix-ndjson-'));

const waitForLines = (
  source: FileSource,
  count: number,
  timeoutMs = 2000
): Promise<LogEvent[]> =>
  new Promise((resolve, reject) => {
    const events: LogEvent[] = [];
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${count} lines, got ${events.length}`));
    }, timeoutMs);

    source.on('line', (event) => {
      events.push(event);
      if (events.length === count) {
        clearTimeout(timer);
        resolve(events);
      }
    });
  });

type TestLogger = {
  warnings: string[];
  debugs: string[];
  warn: (message: string) => void;
  info: (message: string) => void;
  debug: (message: string) => void;
  error: (message: string) => void;
};

const createLogger = (): TestLogger => ({
  warnings: [],
  debugs: [],
  warn(message: string) {
    this.warnings.push(message);
  },
  info() {},
  debug(message: string) {
    this.debugs.push(message);
  },
  error() {},
});

describe('FileSource with NDJSON format', () => {
  it('parses NDJSON lines and extracts message', async () => {
    const tempDir = createTempDir();
    const filePath = path.join(tempDir, 'app.log');
    fs.writeFileSync(filePath, '', 'utf8');

    const source = new FileSource({
      name: 'app',
      type: 'file',
      path: filePath,
      format: 'ndjson',
      ndjson: {
        messageField: 'msg',
      },
    });

    try {
      await source.start();
      await delay(50);

      const eventsPromise = waitForLines(source, 2);
      fs.appendFileSync(
        filePath,
        '{"msg":"First error"}\n{"msg":"Second error"}\n',
        'utf8'
      );

      const events = await eventsPromise;
      expect(events[0].line).toBe('First error');
      expect(events[1].line).toBe('Second error');
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts timestamp from configured field', async () => {
    const tempDir = createTempDir();
    const filePath = path.join(tempDir, 'app.log');
    fs.writeFileSync(filePath, '', 'utf8');

    const source = new FileSource({
      name: 'app',
      type: 'file',
      path: filePath,
      format: 'ndjson',
      ndjson: {
        messageField: 'msg',
        timestampField: 'time',
      },
    });

    try {
      await source.start();
      await delay(50);

      const eventsPromise = waitForLines(source, 1);
      fs.appendFileSync(
        filePath,
        '{"msg":"Error occurred","time":"2025-01-15T10:30:00.000Z"}\n',
        'utf8'
      );

      const [event] = await eventsPromise;
      expect(event.line).toBe('Error occurred');
      expect(event.timestamp.toISOString()).toBe('2025-01-15T10:30:00.000Z');
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('filters lines by level', async () => {
    const tempDir = createTempDir();
    const filePath = path.join(tempDir, 'app.log');
    fs.writeFileSync(filePath, '', 'utf8');

    const source = new FileSource({
      name: 'app',
      type: 'file',
      path: filePath,
      format: 'ndjson',
      ndjson: {
        messageField: 'msg',
        levelField: 'level',
        levelFilter: ['error', 'fatal'],
      },
    });

    const receivedEvents: LogEvent[] = [];
    source.on('line', (event) => {
      receivedEvents.push(event);
    });

    try {
      await source.start();
      await delay(50);

      // Write mix of levels - only error/fatal should be emitted
      fs.appendFileSync(
        filePath,
        '{"msg":"Debug message","level":"debug"}\n' +
          '{"msg":"Info message","level":"info"}\n' +
          '{"msg":"Error message","level":"error"}\n' +
          '{"msg":"Fatal message","level":"fatal"}\n',
        'utf8'
      );

      await delay(300);

      expect(receivedEvents.length).toBe(2);
      expect(receivedEvents[0].line).toBe('Error message');
      expect(receivedEvents[1].line).toBe('Fatal message');
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to raw line on parse error', async () => {
    const tempDir = createTempDir();
    const filePath = path.join(tempDir, 'app.log');
    fs.writeFileSync(filePath, '', 'utf8');

    const source = new FileSource({
      name: 'app',
      type: 'file',
      path: filePath,
      format: 'ndjson',
      ndjson: {
        messageField: 'msg',
      },
    });

    try {
      await source.start();
      await delay(50);

      const eventsPromise = waitForLines(source, 2);
      fs.appendFileSync(
        filePath,
        'not valid json\n{"msg":"Valid JSON"}\n',
        'utf8'
      );

      const events = await eventsPromise;
      expect(events[0].line).toBe('not valid json');
      expect(events[1].line).toBe('Valid JSON');
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to raw line when message field is missing', async () => {
    const tempDir = createTempDir();
    const filePath = path.join(tempDir, 'app.log');
    fs.writeFileSync(filePath, '', 'utf8');

    const logger = createLogger();
    const source = new FileSource(
      {
        name: 'app',
        type: 'file',
        path: filePath,
        format: 'ndjson',
        ndjson: {
          messageField: 'msg',
        },
      },
      { logger }
    );

    try {
      await source.start();
      await delay(50);

      const eventsPromise = waitForLines(source, 1);
      fs.appendFileSync(filePath, '{"other":"value"}\n', 'utf8');

      const [event] = await eventsPromise;
      expect(event.line).toBe('{"other":"value"}');
      expect(logger.debugs.length).toBeGreaterThan(0);
      expect(logger.debugs[0]).toContain('missing message field');
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('handles nested fields with dot notation', async () => {
    const tempDir = createTempDir();
    const filePath = path.join(tempDir, 'app.log');
    fs.writeFileSync(filePath, '', 'utf8');

    const source = new FileSource({
      name: 'app',
      type: 'file',
      path: filePath,
      format: 'ndjson',
      ndjson: {
        messageField: 'log.message',
        timestampField: 'meta.timestamp',
      },
    });

    try {
      await source.start();
      await delay(50);

      const eventsPromise = waitForLines(source, 1);
      fs.appendFileSync(
        filePath,
        '{"log":{"message":"Nested error"},"meta":{"timestamp":"2025-01-15T10:30:00.000Z"}}\n',
        'utf8'
      );

      const [event] = await eventsPromise;
      expect(event.line).toBe('Nested error');
      expect(event.timestamp.toISOString()).toBe('2025-01-15T10:30:00.000Z');
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('handles Bunyan numeric levels', async () => {
    const tempDir = createTempDir();
    const filePath = path.join(tempDir, 'app.log');
    fs.writeFileSync(filePath, '', 'utf8');

    const source = new FileSource({
      name: 'app',
      type: 'file',
      path: filePath,
      format: 'ndjson',
      ndjson: {
        messageField: 'msg',
        levelField: 'level',
        levelFilter: ['error'],
      },
    });

    const receivedEvents: LogEvent[] = [];
    source.on('line', (event) => {
      receivedEvents.push(event);
    });

    try {
      await source.start();
      await delay(50);

      // Bunyan levels: 30=info, 50=error
      fs.appendFileSync(
        filePath,
        '{"msg":"Info","level":30}\n{"msg":"Error","level":50}\n',
        'utf8'
      );

      await delay(300);

      expect(receivedEvents.length).toBe(1);
      expect(receivedEvents[0].line).toBe('Error');
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('works as plain text when format is not specified', async () => {
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

      const eventsPromise = waitForLines(source, 1);
      fs.appendFileSync(filePath, '{"msg":"This is raw JSON"}\n', 'utf8');

      const [event] = await eventsPromise;
      expect(event.line).toBe('{"msg":"This is raw JSON"}');
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('detects appended NDJSON lines', async () => {
    const tempDir = createTempDir();
    const filePath = path.join(tempDir, 'app.log');
    fs.writeFileSync(filePath, '{"msg":"Initial"}\n', 'utf8');

    // Set mtime to past so file isn't considered recent
    const oldTime = new Date(Date.now() - 2000);
    fs.utimesSync(filePath, oldTime, oldTime);

    const source = new FileSource({
      name: 'app',
      type: 'file',
      path: filePath,
      format: 'ndjson',
      ndjson: {
        messageField: 'msg',
      },
    });

    try {
      await source.start();
      await delay(100);

      const eventsPromise = waitForLines(source, 1);
      fs.appendFileSync(filePath, '{"msg":"Appended"}\n', 'utf8');

      const [event] = await eventsPromise;
      expect(event.line).toBe('Appended');
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
