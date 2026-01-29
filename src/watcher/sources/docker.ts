import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { Logger } from '../../utils/logger.js';
import type { DockerSourceConfig, LogEvent, LogSource } from './types.js';

type LoggerLike = Pick<Logger, 'warn' | 'info' | 'debug' | 'error'>;

type DockerSourceOptions = {
  logger?: LoggerLike;
  dockerCommand?: string;
};

const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const KILL_GRACE_MS = 5000;

const DOCKER_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z$/;

type ParsedDockerLine = {
  timestamp: Date;
  message: string;
  checkpoint: string;
};

const normalizeDockerTimestamp = (value: string): string | null => {
  const match = value.match(DOCKER_TIMESTAMP);
  if (!match) {
    return null;
  }
  const base = match[1];
  const fraction = match[2];
  if (!fraction) {
    return `${base}Z`;
  }
  let digits = fraction.slice(1);
  if (digits.length > 3) {
    digits = digits.slice(0, 3);
  } else if (digits.length < 3) {
    digits = digits.padEnd(3, '0');
  }
  return `${base}.${digits}Z`;
};

const parseDockerLine = (line: string): ParsedDockerLine | null => {
  const trimmed = line.trimEnd();
  if (!trimmed) {
    return null;
  }
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex <= 0) {
    return null;
  }
  const rawTimestamp = trimmed.slice(0, spaceIndex);
  const message = trimmed.slice(spaceIndex + 1);
  const normalized = normalizeDockerTimestamp(rawTimestamp);
  if (!normalized) {
    return null;
  }
  const timestamp = new Date(normalized);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }
  return { timestamp, message, checkpoint: normalized };
};

export class DockerSource implements LogSource {
  private readonly config: DockerSourceConfig;
  private readonly logger: LoggerLike;
  private readonly emitter: EventEmitter;
  private readonly dockerCommand: string;
  private child: ChildProcess | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  private backoffMs = BACKOFF_INITIAL_MS;
  private partialLine = '';
  private lastCheckpoint: string | null = null;

  constructor(config: DockerSourceConfig, options?: DockerSourceOptions) {
    this.config = config;
    this.logger =
      options?.logger ?? new Logger({ terminalEnabled: false, verbosity: 'normal' });
    this.emitter = new EventEmitter();
    this.dockerCommand = options?.dockerCommand ?? 'docker';
  }

  async start(): Promise<void> {
    if (this.child || this.reconnectTimer) {
      return;
    }
    this.stopRequested = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.child) {
      const child = this.child;
      this.child = null;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_MS);
      child.once('close', () => clearTimeout(killTimer));
    }
  }

  on(event: 'line', handler: (event: LogEvent) => void): void {
    this.emitter.on(event, handler);
  }

  private connect(): void {
    const args = ['logs', '-f', '--timestamps'];
    if (this.lastCheckpoint) {
      args.push(`--since=${this.lastCheckpoint}`);
    }
    args.push(this.config.container);

    this.logger.info(
      `Connecting to docker logs for ${this.config.container} (since=${this.lastCheckpoint ?? 'beginning'})`
    );

    const child = spawn(this.dockerCommand, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.partialLine = '';

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        this.processChunk(String(data));
      });
    } else {
      this.logger.warn('Docker logs stdout stream unavailable');
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        const text = String(data).trim();
        if (text) {
          this.logger.warn(`Docker logs stderr: ${text}`);
        }
      });
    }

    child.on('close', (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      if (this.stopRequested) {
        return;
      }
      this.logger.warn(
        `Docker logs exited for ${this.config.container} (code=${code ?? 'n/a'}, signal=${signal ?? 'n/a'})`
      );
      this.scheduleReconnect();
    });

    child.on('error', (error) => {
      if (this.child === child) {
        this.child = null;
      }
      if (this.stopRequested) {
        return;
      }
      this.logger.error(
        `Docker logs error for ${this.config.container}: ${error.message}`
      );
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopRequested) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.logger.info(
      `Reconnecting to docker logs for ${this.config.container} in ${delay}ms`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopRequested) {
        this.connect();
      }
    }, delay);
  }

  private processChunk(chunk: string): void {
    const combined = `${this.partialLine}${chunk}`;
    const lines = combined.split('\n');
    this.partialLine = lines.pop() ?? '';

    for (const rawLine of lines) {
      this.handleLine(rawLine.replace(/\r$/, ''));
    }
  }

  private handleLine(line: string): void {
    const parsed = parseDockerLine(line);
    if (parsed) {
      this.lastCheckpoint = parsed.checkpoint;
      this.backoffMs = BACKOFF_INITIAL_MS;
      this.emitter.emit('line', {
        source: this.config.name,
        line: parsed.message,
        timestamp: parsed.timestamp,
      } as LogEvent);
      return;
    }

    this.emitter.emit('line', {
      source: this.config.name,
      line,
      timestamp: new Date(),
    } as LogEvent);
  }
}
