import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

import { Database } from '../../src/db/index.js';
import { getError } from '../../src/db/queries.js';
import {
  createTempDir,
  readFixture,
  removeTempDir,
  writeTempFile,
} from '../helpers/test-utils.js';

const CLI_PATH = path.resolve(process.cwd(), 'dist/cli/index.js');

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
  timeoutMs = 15000,
  intervalMs = 500
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

    const contextPath = match[0].split(' ')[0];
    const resolved = path.isAbsolute(contextPath)
      ? contextPath
      : path.resolve(process.cwd(), contextPath);

    if (!fs.existsSync(resolved)) {
      console.error('Context file missing at:', resolved);
      process.exit(1);
    }

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
  name: watchfix-e2e-autonomous
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

describe('autonomous flow e2e', () => {
  beforeAll(() => {
    ensureCliBuilt();
  });

  it(
    'detects and automatically fixes an error',
    async () => {
      const tempDir = await createTempDir('watchfix-e2e-auto-');
      const logPath = path.join(tempDir, 'logs', 'app.log');
      const dbPath = path.join(tempDir, '.watchfix', 'errors.db');
      const contextDir = path.join(tempDir, '.watchfix', 'context');

      let watchProcess: ReturnType<typeof spawn> | null = null;

      try {
        await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
        await fs.promises.writeFile(logPath, '', 'utf8');

        const mockAgentPath = await createMockAgentScript(tempDir);
        await createConfig(tempDir, logPath, mockAgentPath);

        // Start watch in autonomous mode
        watchProcess = spawn('node', [CLI_PATH, 'watch', '--autonomous', '--verbose'], {
          cwd: tempDir,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Debug output
        watchProcess.stdout?.on('data', (data) => {
          console.log(`[WATCH STDOUT] ${data}`);
        });
        watchProcess.stderr?.on('data', (data) => {
          console.error(`[WATCH STDERR] ${data}`);
        });

        // Wait for database to be initialized
        await waitFor(() => (fs.existsSync(dbPath) ? true : null), 8000);

        // Inject error
        await fs.promises.appendFile(
          logPath,
          'TypeError: Autonomous failure\n',
          'utf8'
        );

        // Wait for error to be detected and status to become 'fixed'
        const db = new Database(dbPath);
        
        const fixedError = await waitFor(() => {
          const row = db.get<{ id: number; status: string }>(
            "SELECT id, status FROM errors WHERE status = 'fixed' ORDER BY id DESC LIMIT 1"
          );
          return row ?? null;
        }, 20000);

        expect(fixedError.status).toBe('fixed');

        // Check activity log for autonomous transitions
        const actions = db
          .all<{ action: string }>(
            'SELECT action FROM activity_log WHERE error_id = ? ORDER BY id ASC',
            [fixedError.id]
          )
          .map((row) => row.action);
        
        db.close();

        const requiredActions = [
          'error_detected',
          'analysis_start',
          'analysis_complete',
          'fix_start',
          'fix_complete',
          'verification_start',
          'verification_pass',
        ];

        let lastIndex = -1;
        for (const action of requiredActions) {
          const nextIndex = actions.indexOf(action);
          expect(nextIndex).toBeGreaterThan(-1);
          expect(nextIndex).toBeGreaterThan(lastIndex);
          lastIndex = nextIndex;
        }

        const contextFiles = fs.existsSync(contextDir)
          ? await fs.promises.readdir(contextDir)
          : [];

        expect(contextFiles.some((file) => file.endsWith('-analyze.md'))).toBe(
          true
        );
        expect(contextFiles.some((file) => file.endsWith('-fix.md'))).toBe(
          true
        );

      } finally {
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