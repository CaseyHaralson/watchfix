import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandSource } from '../../src/watcher/sources/command.js';
import type { LogEvent } from '../../src/watcher/sources/types.js';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const createTempDir = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'watchfix-command-source-'));

const createScript = (dir: string, contents: string): string => {
  const scriptPath = path.join(dir, 'script.js');
  fs.writeFileSync(scriptPath, contents, 'utf8');
  return scriptPath;
};

const waitForEvents = (
  source: CommandSource,
  count: number,
  timeoutMs = 2000
): Promise<LogEvent[]> =>
  new Promise((resolve, reject) => {
    const events: LogEvent[] = [];
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${count} events`));
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

const commandForScript = (scriptPath: string, args: string[] = []): string => {
  const parts = [process.execPath, scriptPath, ...args];
  return parts.map((part) => `"${part}"`).join(' ');
};

describe('CommandSource', () => {
  it('executes command output and emits lines', async () => {
    const tempDir = createTempDir();
    const scriptPath = createScript(
      tempDir,
      "console.log('first');\nconsole.log('second');\n"
    );

    const source = new CommandSource({
      name: 'cmd',
      type: 'command',
      run: commandForScript(scriptPath),
      interval: '0.1s',
    });

    try {
      await source.start();
      const events = await waitForEvents(source, 2);
      expect(events.map((event) => event.line)).toEqual(['first', 'second']);
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('deduplicates lines across runs', async () => {
    const tempDir = createTempDir();
    const scriptPath = createScript(tempDir, "console.log('repeat');\n");

    const source = new CommandSource({
      name: 'cmd',
      type: 'command',
      run: commandForScript(scriptPath),
      interval: '0.05s',
    });

    const events: LogEvent[] = [];
    source.on('line', (event) => events.push(event));

    try {
      await source.start();
      await delay(250);
      expect(events.length).toBe(1);
      expect(events[0].line).toBe('repeat');
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('waits for long command before scheduling the next run', async () => {
    const tempDir = createTempDir();
    const scriptPath = createScript(
      tempDir,
      "const delay = Number(process.argv[2] ?? '0');\n" +
        "setTimeout(() => { console.log(`slow-${Date.now()}`); }, delay);\n"
    );

    const source = new CommandSource({
      name: 'cmd',
      type: 'command',
      run: commandForScript(scriptPath, ['150']),
      interval: '0.05s',
    });

    try {
      await source.start();
      const events = await waitForEvents(source, 2, 5000);
      const first = events[0].timestamp.getTime();
      const second = events[1].timestamp.getTime();
      expect(second - first).toBeGreaterThanOrEqual(130);
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('truncates large output and logs a warning', async () => {
    const tempDir = createTempDir();
    const scriptPath = createScript(
      tempDir,
      [
        "console.log('one');",
        "console.log('two');",
        "console.log('three');",
        "console.log('four');",
        "console.log('five');",
      ].join('\n') + '\n'
    );
    const logger = createLogger();

    const source = new CommandSource(
      {
        name: 'cmd',
        type: 'command',
        run: commandForScript(scriptPath),
        interval: '0.1s',
      },
      { logger, maxLineBuffer: 3 }
    );

    try {
      await source.start();
      const events = await waitForEvents(source, 3);
      expect(events.map((event) => event.line)).toEqual([
        'three',
        'four',
        'five',
      ]);
      expect(logger.warnings[0]).toBe(
        'Command output truncated: kept last 3 of 5 lines'
      );
    } finally {
      await source.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
