import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

import { Database } from '../../src/db/index.js';
import {
  createTempDir,
  readFixture,
  removeTempDir,
  writeTempFile,
} from '../helpers/test-utils.js';

const CLI_PATH = path.resolve(process.cwd(), 'dist/cli/index.js');

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const ensureCliBuilt = (): void => {
  if (fs.existsSync(CLI_PATH)) {
    return;
  }

  const tscPath = path.resolve(
    process.cwd(),
    'node_modules',
    'typescript',
    'bin',
    'tsc'
  );
  const result = spawnSync(process.execPath, [tscPath, '-p', 'tsconfig.json'], {
    cwd: process.cwd(),
    env: { ...process.env },
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`Failed to build CLI for tests.\n${details}`);
  }
};

const waitFor = async <T>(
  fn: () => T | null | undefined,
  timeoutMs = 10000,
  intervalMs = 200
): Promise<T> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value) {
      return value;
    }
    await delay(intervalMs);
  }
  throw new Error('Timed out waiting for condition');
};

const runCli = async (
  args: string[],
  cwd: string,
  cliPath: string = CLI_PATH
): Promise<CliResult> =>
  await new Promise((resolve, reject) => {
    const child = spawn('node', [cliPath, ...args], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });

const createMockAgentScript = async (rootDir: string): Promise<string> => {
  const analysisYaml = readFixture('agent-responses/analysis-valid.yaml');
  const fixYaml = readFixture('agent-responses/fix-valid.yaml');
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');

    const prompt = process.argv.slice(2).join(' ');
    if (!prompt) {
      console.error('No prompt provided');
      process.exit(1);
    }

    const match = prompt.match(/\\.watchfix[\\\\/]context[\\\\/][^\\s"]+/);
    if (!match) {
      console.error('No context path found in prompt');
      process.exit(1);
    }

    const contextPath = match[0];
    const resolved = path.isAbsolute(contextPath)
      ? contextPath
      : path.resolve(process.cwd(), contextPath);

    const isAnalyze = contextPath.endsWith('-analyze.md');
    const isFix = contextPath.endsWith('-fix.md');

    const outputPath = isAnalyze
      ? resolved.replace('-analyze.md', '-analysis.yaml')
      : resolved.replace('-fix.md', '-result.yaml');

    const response = isAnalyze
      ? ${JSON.stringify(analysisYaml)}
      : ${JSON.stringify(fixYaml)};

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, response, 'utf8');
  `;

  return await writeTempFile(rootDir, 'mock-agent.js', script);
};

const createConfig = async (
  rootDir: string,
  logPath: string,
  mockAgentPath: string
): Promise<string> => {
  const config = `
project:
  name: watchfix-e2e-daemon
  root: .

agent:
  provider: codex
  command: node
  args:
    - ${JSON.stringify(`./${path.relative(rootDir, mockAgentPath)}`)}
  timeout: 10s
  retries: 0

logs:
  sources:
    - name: app
      type: file
      path: ${JSON.stringify(`./${path.relative(rootDir, logPath)}`)}
  context_lines_before: 2
  context_lines_after: 2
  max_line_buffer: 1000

verification:
  test_commands:
    - node -e "process.exit(0)"
  test_command_timeout: 5s
  health_checks: []
  health_check_timeout: 5s
  wait_after_fix: 1s

limits:
  max_attempts_per_error: 1

cleanup:
  context_max_age_days: 1
  context_max_size_kb: 128
`;

  return await writeTempFile(rootDir, 'watchfix.yaml', config.trimStart());
};

const createCliShim = async (rootDir: string): Promise<string> => {
  const shimPath = path.join(rootDir, 'watchfix.js');
  await fs.promises.symlink(CLI_PATH, shimPath);
  return shimPath;
};

const getWatcherPid = (dbPath: string): number | null => {
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  const db = new Database(dbPath);
  try {
    try {
      const row = db.get<{ pid: number }>(
        'SELECT pid FROM watcher_state WHERE id = 1'
      );
      return row?.pid ?? null;
    } catch {
      return null;
    }
  } finally {
    db.close();
  }
};

const waitForProcessExit = async (
  pid: number,
  timeoutMs = 10_000
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await delay(200);
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe('daemon lifecycle e2e', () => {
  beforeAll(() => {
    ensureCliBuilt();
  });

  const isWindows = process.platform === 'win32';
  const itIf = isWindows ? it.skip : it;

  itIf(
    'starts daemon, reports running, stops cleanly',
    async () => {
      const tempDir = await createTempDir('watchfix-e2e-daemon-');
      const logPath = path.join(tempDir, 'logs', 'app.log');
      const dbPath = path.join(tempDir, '.watchfix', 'errors.db');

      let daemonPid: number | null = null;
      let cliShim: string | null = null;

      try {
        await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
        await fs.promises.writeFile(logPath, '', 'utf8');

        const mockAgentPath = await createMockAgentScript(tempDir);
        await createConfig(tempDir, logPath, mockAgentPath);
        cliShim = await createCliShim(tempDir);

        const startResult = await runCli(['watch', '--daemon'], tempDir, cliShim);
        expect(startResult.code).toBe(0);
        expect(startResult.stdout).toContain('Started watchfix daemon');

        daemonPid = await waitFor(() => getWatcherPid(dbPath), 15000);

        const statusRunning = await runCli(['status'], tempDir, cliShim);
        expect(statusRunning.code).toBe(0);
        expect(statusRunning.stdout).toContain('Watcher: running');

        const stopResult = await runCli(['stop'], tempDir, cliShim);
        expect(stopResult.code).toBe(0);
        expect(stopResult.stdout).toContain('Watcher stopped');

        const statusStopped = await runCli(['status'], tempDir, cliShim);
        expect(statusStopped.code).toBe(0);
        expect(statusStopped.stdout).toContain('Watcher: not running');
      } finally {
        if (daemonPid) {
          try {
            process.kill(daemonPid, 'SIGTERM');
          } catch {
            // ignore
          }
          await waitForProcessExit(daemonPid, 5000);
        }
        await removeTempDir(tempDir);
      }
    },
    45_000
  );

  itIf(
    'handles SIGTERM shutdown gracefully',
    async () => {
      const tempDir = await createTempDir('watchfix-e2e-daemon-sigterm-');
      const logPath = path.join(tempDir, 'logs', 'app.log');
      const dbPath = path.join(tempDir, '.watchfix', 'errors.db');

      let daemonPid: number | null = null;
      let cliShim: string | null = null;

      try {
        await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
        await fs.promises.writeFile(logPath, '', 'utf8');

        const mockAgentPath = await createMockAgentScript(tempDir);
        await createConfig(tempDir, logPath, mockAgentPath);
        cliShim = await createCliShim(tempDir);

        const startResult = await runCli(['watch', '--daemon'], tempDir, cliShim);
        expect(startResult.code).toBe(0);

        daemonPid = await waitFor(() => getWatcherPid(dbPath), 15000);

        process.kill(daemonPid, 'SIGTERM');
        const exited = await waitForProcessExit(daemonPid, 15000);
        expect(exited).toBe(true);

        const statusAfter = await runCli(['status'], tempDir, cliShim);
        expect(statusAfter.code).toBe(0);
        expect(statusAfter.stdout).toContain('Watcher: not running');
        expect(statusAfter.stdout).not.toContain('cleared stale state');
      } finally {
        if (daemonPid) {
          try {
            process.kill(daemonPid, 'SIGTERM');
          } catch {
            // ignore
          }
          await waitForProcessExit(daemonPid, 5000);
        }
        await removeTempDir(tempDir);
      }
    },
    45_000
  );
});
