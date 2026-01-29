import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkCliExists,
  isOurProcess,
  spawnWithTimeout,
} from '../../src/utils/process.js';

const spawned: Array<{ pid: number; kill: () => void }> = [];

afterEach(() => {
  for (const child of spawned) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // Ignore already-exited processes.
    }
  }
  spawned.length = 0;
});

describe('checkCliExists', () => {
  it('returns exists true for node', () => {
    const result = checkCliExists(process.execPath);
    expect(result.exists).toBe(true);
    expect(result.version).toBeDefined();
  });

  it('returns exists false for missing command', () => {
    const result = checkCliExists('watchfix-cli-does-not-exist');
    expect(result.exists).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('spawnWithTimeout', () => {
  it('captures stdout for successful commands', async () => {
    const result = await spawnWithTimeout(
      process.execPath,
      ['-e', 'console.log("ok")'],
      {},
      1000,
    );
    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('ok');
    expect(result.timedOut).toBe(false);
  });

  it('kills processes that exceed timeout', async () => {
    const result = await spawnWithTimeout(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10000)'],
      {},
      50,
    );
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
  });
});

describe('isOurProcess', () => {
  it('returns false for unrelated process', () => {
    expect(isOurProcess(process.pid, process.cwd())).toBe(false);
  });

  it('returns true when command line matches', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10000)', 'watchfix', process.cwd()],
      { stdio: 'ignore' },
    );
    if (!child.pid) {
      throw new Error('Failed to spawn child process');
    }
    spawned.push({ pid: child.pid, kill: () => child.kill('SIGKILL') });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isOurProcess(child.pid, process.cwd())).toBe(true);
  });
});
