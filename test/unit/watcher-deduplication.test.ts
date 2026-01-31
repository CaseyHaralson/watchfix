import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../../src/db/index.js';
import { initializeSchema } from '../../src/db/schema.js';
import { insertError } from '../../src/db/queries.js';
import { WatcherOrchestrator } from '../../src/watcher/index.js';
import type { Config } from '../../src/config/schema.js';
import { createTempDir, removeTempDir, writeTempFile } from '../helpers/test-utils.js';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type TempState = {
  dir: string;
  dbPath: string;
  logPath: string;
  db: Database;
};

let state: TempState | null = null;

const setupState = async (): Promise<TempState> => {
  const dir = await createTempDir('watchfix-watcher-test-');
  const dbPath = path.join(dir, '.watchfix', 'errors.db');
  const db = new Database(dbPath);
  initializeSchema(db);
  const logPath = path.join(dir, 'test.log');
  await writeTempFile(dir, 'test.log', '');
  return { dir, dbPath, logPath, db };
};

const createConfig = (state: TempState, overrides: Partial<Config> = {}): Config =>
  ({
    project: { name: 'test', root: state.dir },
    agent: {
      provider: 'codex',
      timeout: '5m',
      retries: 2,
    },
    logs: {
      sources: [{ name: 'test', type: 'file', path: state.logPath }],
      context_lines_before: 10,
      context_lines_after: 5,
      max_line_buffer: 10000,
    },
    verification: {
      test_commands: [],
      test_command_timeout: '5m',
      health_checks: [],
      health_check_timeout: '10s',
      wait_after_fix: '5s',
    },
    limits: { max_attempts_per_error: 3 },
    cleanup: { context_max_age_days: 7, context_max_size_kb: 256 },
    deduplication: { fixed_grace_period: '10m' },
    patterns: { match: [], ignore: [] },
    ...overrides,
  }) as Config;

beforeEach(async () => {
  state = await setupState();
});

afterEach(async () => {
  if (state) {
    state.db.close();
    await removeTempDir(state.dir);
    state = null;
  }
});

describe('WatcherOrchestrator deduplication', () => {
  it('deduplicates fixed errors within grace period', async () => {
    if (!state) throw new Error('missing test state');

    const config = createConfig(state, {
      deduplication: { fixed_grace_period: '10m' },
    });

    const watcher = new WatcherOrchestrator(config, state.db);

    const detectedEvents: unknown[] = [];
    const deduplicatedEvents: unknown[] = [];
    watcher.on('error_detected', (e) => detectedEvents.push(e));
    watcher.on('error_deduplicated', (e) => deduplicatedEvents.push(e));

    // Insert a fixed error that matches what the parser will produce
    // Hash is computed from: source + errorType + normalizedMessage
    // where message is the FULL LINE (e.g., "TypeError: test error")
    const timestamp = new Date().toISOString();
    insertError(state.db, {
      hash: '3e449e375eec6a9c0d8bf269c5a81e6cc5a383b6a02eb3b6551f8e81dbb086f8',
      source: 'test',
      timestamp,
      errorType: 'TypeError',
      message: 'TypeError: test error',
      rawLog: 'TypeError: test error',
      status: 'fixed',
    });

    try {
      await watcher.start();
      await delay(100);

      // Trigger the same error via the log file
      await fs.promises.appendFile(state.logPath, 'TypeError: test error\n');
      await delay(500);

      // Should be deduplicated, not detected as new
      expect(deduplicatedEvents.length).toBe(1);
      expect(detectedEvents.length).toBe(0);
    } finally {
      await watcher.stop();
    }
  });

  it('detects recurring error after grace period expires', async () => {
    if (!state) throw new Error('missing test state');

    // Use a very short grace period
    const config = createConfig(state, {
      deduplication: { fixed_grace_period: '1s' },
    });

    const watcher = new WatcherOrchestrator(config, state.db);

    const detectedEvents: unknown[] = [];
    const deduplicatedEvents: unknown[] = [];
    watcher.on('error_detected', (e) => detectedEvents.push(e));
    watcher.on('error_deduplicated', (e) => deduplicatedEvents.push(e));

    // Insert a fixed error with old timestamp
    const oldTime = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago
    insertError(state.db, {
      hash: 'cf0cf7c0fcb694df083c04ecfcd815a88aaa2c251781e5569c2528568fe362f2',
      source: 'test',
      timestamp: oldTime,
      errorType: 'ReferenceError',
      message: 'ReferenceError: old error',
      rawLog: 'ReferenceError: old error',
      status: 'fixed',
      updatedAt: oldTime,
    });

    try {
      await watcher.start();
      // Wait for grace period to expire
      await delay(1100);

      // Trigger the same error via the log file
      await fs.promises.appendFile(state.logPath, 'ReferenceError: old error\n');
      await delay(500);

      // Should be detected as recurring error, not deduplicated
      expect(detectedEvents.length).toBe(1);
      expect(deduplicatedEvents.length).toBe(0);
    } finally {
      await watcher.stop();
    }
  });

  it('always deduplicates errors with active status', async () => {
    if (!state) throw new Error('missing test state');

    const config = createConfig(state);
    const watcher = new WatcherOrchestrator(config, state.db);

    const detectedEvents: unknown[] = [];
    const deduplicatedEvents: unknown[] = [];
    watcher.on('error_detected', (e) => detectedEvents.push(e));
    watcher.on('error_deduplicated', (e) => deduplicatedEvents.push(e));

    // Insert a pending error
    const timestamp = new Date().toISOString();
    insertError(state.db, {
      hash: '7115ddbe53f40343fa8b78a496b882179b2ff9aace966e631f65f10de1647259',
      source: 'test',
      timestamp,
      errorType: 'SyntaxError',
      message: 'SyntaxError: pending error',
      rawLog: 'SyntaxError: pending error',
      status: 'pending',
    });

    try {
      await watcher.start();
      await delay(100);

      // Trigger the same error via the log file
      await fs.promises.appendFile(state.logPath, 'SyntaxError: pending error\n');
      await delay(500);

      // Should be deduplicated (active status)
      expect(deduplicatedEvents.length).toBe(1);
      expect(detectedEvents.length).toBe(0);
    } finally {
      await watcher.stop();
    }
  });
});
