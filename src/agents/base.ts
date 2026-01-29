import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Agent, AgentConfig, AgentResult } from './types.js';
import { Logger } from '../utils/logger.js';

type BaseAgentOptions = {
  projectRoot: string;
  logger?: Logger;
  terminalEnabled?: boolean;
};

type AgentMode = 'analyze' | 'fix';

const KILL_GRACE_PERIOD_MS = 5000;

const PROMPTS = {
  analyze: (contextPath: string): string =>
    `Read ${contextPath} and follow the instructions.`,
  fix: (contextPath: string): string =>
    `Read ${contextPath} and follow the instructions.`,
} as const;

const outputPathForContext = (contextPath: string): string | null => {
  if (contextPath.endsWith('-analyze.md')) {
    return contextPath.replace(/-analyze\.md$/, '-analysis.yaml');
  }
  if (contextPath.endsWith('-fix.md')) {
    return contextPath.replace(/-fix\.md$/, '-result.yaml');
  }
  return null;
};

export class BaseAgent implements Agent {
  config: AgentConfig;
  private readonly projectRoot: string;
  private readonly logger: Logger;
  private readonly terminalEnabled: boolean;

  constructor(config: AgentConfig, options: BaseAgentOptions) {
    this.config = config;
    this.projectRoot = options.projectRoot;
    this.terminalEnabled = options.terminalEnabled ?? true;
    this.logger =
      options.logger ??
      new Logger({ rootDir: this.projectRoot, terminalEnabled: this.terminalEnabled });
  }

  async analyze(contextPath: string): Promise<AgentResult> {
    return await this.run('analyze', contextPath);
  }

  async fix(contextPath: string): Promise<AgentResult> {
    return await this.run('fix', contextPath);
  }

  private async run(mode: AgentMode, contextPath: string): Promise<AgentResult> {
    const attempts = Math.max(0, this.config.retries) + 1;
    let lastResult: AgentResult | null = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      lastResult = await this.executeOnce(mode, contextPath);
      if (lastResult.success) {
        return lastResult;
      }
      if (attempt < attempts) {
        this.logger.warn(
          `Agent ${this.config.provider} ${mode} attempt ${attempt} failed; retrying`
        );
      }
    }

    return (
      lastResult ?? {
        success: false,
        stdout: '',
        stderr: 'Agent execution failed',
        exitCode: -1,
        timedOut: false,
        outputFileExists: false,
      }
    );
  }

  private async executeOnce(
    mode: AgentMode,
    contextPath: string
  ): Promise<AgentResult> {
    const prompt = PROMPTS[mode](contextPath);
    const command = this.config.command;
    const args = [...this.config.args, prompt];
    const resolvedContextPath = path.isAbsolute(contextPath)
      ? contextPath
      : path.resolve(this.projectRoot, contextPath);
    const outputPathRaw = outputPathForContext(resolvedContextPath);
    const outputPath =
      outputPathRaw && !path.isAbsolute(outputPathRaw)
        ? path.resolve(this.projectRoot, outputPathRaw)
        : outputPathRaw;

    return await new Promise<AgentResult>((resolve) => {
      const child = spawn(command, args, {
        cwd: this.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let resolved = false;

      const finalize = (result: AgentResult): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        resolve(result);
      };

      const timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');

        const killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, KILL_GRACE_PERIOD_MS);

        child.once('close', () => clearTimeout(killTimer));
      }, this.config.timeout);

      if (child.stdout) {
        child.stdout.on('data', (data) => {
          stdout += String(data);
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (data) => {
          const chunk = String(data);
          stderr += chunk;
          if (this.config.stderrIsProgress && this.terminalEnabled) {
            process.stderr.write(chunk);
          }
        });
      }

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        const outputFileExists = outputPath ? fs.existsSync(outputPath) : false;
        finalize({
          success: false,
          stdout,
          stderr: error.message,
          exitCode: -1,
          timedOut: false,
          outputFileExists,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        const outputFileExists = outputPath ? fs.existsSync(outputPath) : false;
        const trimmedStderr = stderr.trim();
        if (trimmedStderr && !this.config.stderrIsProgress) {
          this.logger.warn(`Agent stderr: ${trimmedStderr}`);
        }
        finalize({
          success: code === 0 && !timedOut,
          stdout,
          stderr,
          exitCode: code ?? -1,
          timedOut,
          outputFileExists,
        });
      });
    });
  }
}
