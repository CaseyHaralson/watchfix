import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Logger } from '../../utils/logger.js';
import { parseDuration } from '../../utils/duration.js';
import type { CommandSourceConfig, LogEvent, LogSource } from './types.js';

type LoggerLike = Pick<Logger, 'warn' | 'info' | 'debug' | 'error'>;

type CommandSourceOptions = {
  logger?: LoggerLike;
  maxLineBuffer?: number;
};

type CommandOutput = {
  lines: string[];
  totalLines: number;
  truncated: boolean;
  exitCode: number;
};

const DEFAULT_MAX_LINE_BUFFER = 10_000;

const hashLine = (line: string): string =>
  createHash('sha256').update(line).digest('hex');

const normalizeLines = (output: string): string[] => {
  if (!output) {
    return [];
  }
  const lines = output.split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
};

export class CommandSource implements LogSource {
  private readonly config: CommandSourceConfig;
  private readonly logger: LoggerLike;
  private readonly emitter: EventEmitter;
  private readonly intervalMs: number;
  private readonly maxLineBuffer: number;
  private readonly seenHashes = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopRequested = false;

  constructor(config: CommandSourceConfig, options?: CommandSourceOptions) {
    this.config = config;
    this.logger =
      options?.logger ?? new Logger({ terminalEnabled: false, verbosity: 'normal' });
    this.emitter = new EventEmitter();
    this.intervalMs = parseDuration(config.interval);
    const maxLineBuffer = options?.maxLineBuffer ?? DEFAULT_MAX_LINE_BUFFER;
    this.maxLineBuffer = Math.max(1, maxLineBuffer);
  }

  async start(): Promise<void> {
    if (this.running || this.timer) {
      return;
    }
    this.stopRequested = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  on(event: 'line', handler: (event: LogEvent) => void): void {
    this.emitter.on(event, handler);
  }

  private schedule(delayMs: number): void {
    if (this.stopRequested) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce();
    }, delayMs);
  }

  private async runOnce(): Promise<void> {
    if (this.running || this.stopRequested) {
      return;
    }
    this.running = true;
    try {
      const output = await this.executeCommand();
      if (output.truncated) {
        this.logger.warn(
          `Command output truncated: kept last ${this.maxLineBuffer} of ${output.totalLines} lines`
        );
      }
      if (output.exitCode !== 0) {
        this.logger.warn(
          `Command '${this.config.run}' exited with code ${output.exitCode}`
        );
      }
      for (const line of output.lines) {
        this.emitLine(line);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Command source '${this.config.name}' failed to run: ${message}`
      );
    } finally {
      this.running = false;
      if (!this.stopRequested) {
        this.schedule(this.intervalMs);
      }
    }
  }

  private emitLine(line: string): void {
    const hash = hashLine(line);
    if (this.seenHashes.has(hash)) {
      return;
    }
    this.seenHashes.add(hash);
    this.emitter.emit('line', {
      source: this.config.name,
      line,
      timestamp: new Date(),
    } as LogEvent);
  }

  private async executeCommand(): Promise<CommandOutput> {
    return await new Promise<CommandOutput>((resolve, reject) => {
      const child = spawn(this.config.run, {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      if (child.stdout) {
        child.stdout.on('data', (data) => {
          stdout += String(data);
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (data) => {
          stderr += String(data);
        });
      }

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        const combined =
          stdout && stderr ? `${stdout}\n${stderr}` : stdout || stderr;
        const lines = normalizeLines(combined);
        const totalLines = lines.length;
        let truncated = false;
        let keptLines = lines;
        if (lines.length > this.maxLineBuffer) {
          truncated = true;
          keptLines = lines.slice(-this.maxLineBuffer);
        }
        resolve({
          lines: keptLines,
          totalLines,
          truncated,
          exitCode: code ?? -1,
        });
      });
    });
  }
}
