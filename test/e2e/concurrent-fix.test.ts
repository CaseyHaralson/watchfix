import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

import { Database } from '../../src/db/index.js';
import { getError } from '../../src/db/queries.js';
import { EXIT_CODES } from '../../src/utils/errors.js';
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

type CliProcess = {
  child: ReturnType<typeof spawn>;
  done: Promise<CliResult>;
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
  timeoutMs = 8000,
  intervalMs = 100
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

const spawnCli = (args: string[], cwd: string): CliProcess => {
  const child = spawn('node', [CLI_PATH, ...args], {
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

  const done = new Promise<CliResult>((resolve, reject) => {
    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });

  return { child, done };
};

const createMockAgentScript = async (rootDir: string): Promise<string> => {
  const analysisYaml = readFixture('agent-responses/analysis-valid.yaml');
  const fixYaml = readFixture('agent-responses/fix-valid.yaml');
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    (async () => {
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

      if (!fs.existsSync(resolved)) {
        console.error('Context file missing');
        process.exit(1);
      }

      const isAnalyze = contextPath.endsWith('-analyze.md');
      const isFix = contextPath.endsWith('-fix.md');
      if (!isAnalyze && !isFix) {
        console.error('Unsupported context mode');
        process.exit(1);
      }

      const outputPath = isAnalyze
        ? resolved.replace('-analyze.md', '-analysis.yaml')
        : resolved.replace('-fix.md', '-result.yaml');

      if (isAnalyze) {
        await sleep(750);
      } else {
        await sleep(1500);
      }

      const response = isAnalyze
        ? ${JSON.stringify(analysisYaml)}
        : ${JSON.stringify(fixYaml)};

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, response, 'utf8');
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
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
  name: watchfix-e2e-concurrent
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
    - node -e "setTimeout(() => process.exit(0), 1500)"
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

describe('concurrent fix e2e', () => {
  beforeAll(() => {
    ensureCliBuilt();
  });

  it(
    'prevents concurrent fix attempts for the same error',
    async () => {
      const tempDir = await createTempDir('watchfix-e2e-concurrent-');
      const logPath = path.join(tempDir, 'logs', 'app.log');
      const dbPath = path.join(tempDir, '.watchfix', 'errors.db');

      let watchProcess: ReturnType<typeof spawn> | null = null;
      let db: Database | null = null;

      try {
        await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
        await fs.promises.writeFile(logPath, '', 'utf8');

        const mockAgentPath = await createMockAgentScript(tempDir);
        await createConfig(tempDir, logPath, mockAgentPath);

        watchProcess = spawn('node', [CLI_PATH, 'watch'], {
          cwd: tempDir,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        await waitFor(() => (fs.existsSync(dbPath) ? true : null), 8000);

        await fs.promises.appendFile(
          logPath,
          'TypeError: Concurrent failure\n',
          'utf8'
        );

        db = new Database(dbPath);
        const errorRow = await waitFor(() => {
          const row = db?.get<{ id: number; status: string }>(
            'SELECT id, status FROM errors ORDER BY id DESC LIMIT 1'
          );
          return row ?? null;
        }, 8000);

        expect(errorRow.status).toBe('pending');

        const firstFix = spawnCli(['fix', String(errorRow.id), '--yes'], tempDir);

        await waitFor(() => {
          const row = getError(db as Database, errorRow.id);
          return row?.lockedBy ? row : null;
        }, 8000, 50);

        const secondFix = spawnCli(
          ['fix', String(errorRow.id), '--yes'],
          tempDir
        );
        const secondResult = await secondFix.done;

        expect(secondResult.code).toBe(EXIT_CODES.NOT_ACTIONABLE);
        const combinedOutput = `${secondResult.stdout}${secondResult.stderr}`;
        const expectedMessages = [
          `Skipped error #${errorRow.id}: already locked by another process.`,
          `Error #${errorRow.id} is currently analyzing.`,
          `Error #${errorRow.id} is currently fixing.`,
        ];
        expect(expectedMessages.some((msg) => combinedOutput.includes(msg))).toBe(
          true
        );

        const firstResult = await firstFix.done;
        expect(firstResult.code).toBe(EXIT_CODES.SUCCESS);

        const fixedError = await waitFor(() => {
          const row = getError(db as Database, errorRow.id);
          return row?.status === 'fixed' ? row : null;
        }, 10000);

        expect(fixedError.status).toBe('fixed');

        const fixStarts = (db as Database)
          .all<{ action: string }>(
            "SELECT action FROM activity_log WHERE error_id = ? AND action = 'fix_start'",
            [errorRow.id]
          )
          .map((row) => row.action);

        expect(fixStarts).toHaveLength(1);
      } finally {
        if (db) {
          db.close();
        }
        if (
          watchProcess &&
          watchProcess.exitCode === null &&
          watchProcess.signalCode === null
        ) {
          watchProcess.kill('SIGINT');
          await new Promise<void>((resolve) => {
            watchProcess?.once('close', () => resolve());
          });
        }
        await removeTempDir(tempDir);
      }
    },
    45_000
  );
});
