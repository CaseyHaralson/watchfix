import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { configSchema } from '../../src/config/schema.js';
import { runVerification } from '../../src/fixer/verifier.js';
import { Logger } from '../../src/utils/logger.js';

const tempDirs: string[] = [];

const createTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchfix-verifier-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

const quotePath = (value: string): string =>
  value.includes(' ') ? `"${value}"` : value;

const buildConfig = (root: string, verification: Record<string, unknown>) =>
  configSchema.parse({
    project: { name: 'watchfix-test', root },
    agent: { provider: 'codex' },
    logs: {
      sources: [
        {
          name: 'test-source',
          type: 'file',
          path: path.join(root, 'app.log'),
        },
      ],
    },
    verification,
    limits: {},
    cleanup: {},
    patterns: {},
  });

describe('runVerification', () => {
  it('passes when no commands or health checks are configured', async () => {
    const root = createTempDir();
    const config = buildConfig(root, {
      test_commands: [],
      health_checks: [],
      wait_after_fix: '5s',
    });
    const sleepCalls: number[] = [];

    const result = await runVerification(config, {
      logger: new Logger({ rootDir: root, terminalEnabled: false }),
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(result.success).toBe(true);
    expect(result.commandResults).toHaveLength(0);
    expect(result.healthCheckResults).toHaveLength(0);
    expect(sleepCalls).toEqual([5000]);
  });

  it('runs commands in a shell', async () => {
    const root = createTempDir();
    const config = buildConfig(root, {
      test_commands: ['echo watchfix'],
      health_checks: [],
      wait_after_fix: '1s',
    });

    const result = await runVerification(config, {
      logger: new Logger({ rootDir: root, terminalEnabled: false }),
      sleep: async () => {},
    });

    expect(result.success).toBe(true);
    expect(result.commandResults[0]?.stdout).toContain('watchfix');
  });

  it('stops on the first failing command', async () => {
    const root = createTempDir();
    const node = quotePath(process.execPath);
    const commands = [
      `${node} -e "require('fs').writeFileSync('first.txt','ok')"`,
      `${node} -e "process.exit(1)"`,
      `${node} -e "require('fs').writeFileSync('third.txt','ok')"`,
    ];
    const config = buildConfig(root, {
      test_commands: commands,
      health_checks: [],
      wait_after_fix: '1s',
      test_command_timeout: '5s',
    });

    const result = await runVerification(config, {
      logger: new Logger({ rootDir: root, terminalEnabled: false }),
      sleep: async () => {},
    });

    expect(result.success).toBe(false);
    expect(result.failure?.type).toBe('command');
    expect(result.commandResults).toHaveLength(2);
    expect(fs.existsSync(path.join(root, 'first.txt'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'third.txt'))).toBe(false);
  });

  it('fails on the first unhealthy health check', async () => {
    const root = createTempDir();
    const server = http.createServer((_, res) => {
      res.statusCode = 500;
      res.end('fail');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Failed to get server address');
    }
    const url = `http://127.0.0.1:${address.port}/health`;

    const config = buildConfig(root, {
      test_commands: [],
      health_checks: [url],
      wait_after_fix: '1s',
      health_check_timeout: '5s',
    });

    try {
      const result = await runVerification(config, {
        logger: new Logger({ rootDir: root, terminalEnabled: false }),
        sleep: async () => {},
      });

      expect(result.success).toBe(false);
      expect(result.failure?.type).toBe('health_check');
      expect(result.failure?.status).toBe(500);
    } finally {
      server.close();
    }
  });
});
