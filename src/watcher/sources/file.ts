import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import chokidar, { type FSWatcher } from 'chokidar';
import { Logger } from '../../utils/logger.js';
import type { FileSourceConfig, LogEvent, LogSource } from './types.js';

type LoggerLike = Pick<Logger, 'warn' | 'info' | 'debug' | 'error'>;

type FileSourceOptions = {
  logger?: LoggerLike;
};

export class FileSource implements LogSource {
  private readonly config: FileSourceConfig;
  private readonly filePath: string;
  private readonly logger: LoggerLike;
  private readonly emitter: EventEmitter;
  private watcher: FSWatcher | null = null;
  private position = 0;
  private partialLine = '';
  private reading = false;
  private queued = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastMtimeMs: number | null = null;
  private lastInode: number | null = null;
  private forceRead = false;

  constructor(config: FileSourceConfig, options?: FileSourceOptions) {
    this.config = config;
    this.filePath = path.resolve(config.path);
    this.logger =
      options?.logger ?? new Logger({ terminalEnabled: false, verbosity: 'normal' });
    this.emitter = new EventEmitter();
  }

  async start(): Promise<void> {
    if (this.watcher) {
      return;
    }

    const exists = fs.existsSync(this.filePath);
    if (exists) {
      const stats = fs.statSync(this.filePath);
      const now = Date.now();
      const RECENT_WINDOW_MS = 1000;
      const STARTUP_READ_MAX_BYTES = 64 * 1024;
      const recentWrite = now - stats.mtimeMs <= RECENT_WINDOW_MS;
      const readFromStart = stats.size > 0 && stats.size <= STARTUP_READ_MAX_BYTES && recentWrite;
      this.position = readFromStart ? 0 : stats.size;
      this.lastMtimeMs = stats.mtimeMs;
      this.lastInode = typeof stats.ino === 'number' ? stats.ino : null;
    } else {
      this.position = 0;
      this.logger.warn(`Log file not found: ${this.filePath}. Waiting for creation.`);
    }

    const targets = exists
      ? [this.filePath]
      : [this.filePath, path.dirname(this.filePath)];

    this.watcher = chokidar.watch(targets, {
      ignoreInitial: true,
      usePolling: true,
      interval: 100,
    });

    const watcher = this.watcher;
    const readyPromise = new Promise<void>((resolve, reject) => {
      watcher.once('ready', () => resolve());
      watcher.once('error', (error) => reject(error));
    });

    watcher.on('add', (eventPath) => {
      if (path.resolve(eventPath) !== this.filePath) {
        return;
      }
      this.queueRead(true);
    });

    watcher.on('change', (eventPath) => {
      if (path.resolve(eventPath) !== this.filePath) {
        return;
      }
      this.queueRead(true);
    });

    await readyPromise;
    this.pollTimer = setInterval(() => this.queueRead(), 200);
  }

  async stop(): Promise<void> {
    if (!this.watcher) {
      return;
    }

    await this.watcher.close();
    this.watcher = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  on(event: 'line', handler: (event: LogEvent) => void): void {
    this.emitter.on(event, handler);
  }

  private queueRead(force = false): void {
    if (force) {
      this.forceRead = true;
    }
    if (this.reading) {
      this.queued = true;
      return;
    }

    this.reading = true;
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    try {
      do {
        this.queued = false;
        await this.readNewLines();
      } while (this.queued);
    } finally {
      this.reading = false;
    }
  }

  private async readNewLines(): Promise<void> {
    let stats: fs.Stats | null = null;
    try {
      stats = await fs.promises.stat(this.filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return;
      }
      throw error;
    }

    if (!stats) {
      return;
    }

    const inode = typeof stats.ino === 'number' ? stats.ino : null;
    const mtimeMs = stats.mtimeMs;
    this.forceRead = false;
    const inodeChanged =
      this.lastInode !== null && inode !== null && inode !== this.lastInode;

    // Only reset position on actual file replacement (inode change) or truncation (size shrunk)
    // Do NOT reset on mtime changes without content changes - this prevents re-reading
    // old errors when the file is touched but no new content is added
    if (inodeChanged || stats.size < this.position) {
      this.position = 0;
      this.partialLine = '';
    }

    if (stats.size === this.position) {
      this.lastMtimeMs = mtimeMs;
      this.lastInode = inode;
      return;
    }

    const length = stats.size - this.position;
    const handle = await fs.promises.open(this.filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        length,
        this.position
      );
      if (bytesRead <= 0) {
        this.lastMtimeMs = mtimeMs;
        this.lastInode = inode;
        return;
      }
      this.position += bytesRead;
      const chunk = buffer.toString('utf8', 0, bytesRead);
      this.processChunk(chunk);
      this.lastMtimeMs = mtimeMs;
      this.lastInode = inode;
    } finally {
      await handle.close();
    }
  }

  private processChunk(chunk: string): void {
    const combined = `${this.partialLine}${chunk}`;
    const lines = combined.split('\n');
    this.partialLine = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      this.emitter.emit('line', {
        source: this.config.name,
        line,
        timestamp: new Date(),
      } as LogEvent);
    }
  }
}
