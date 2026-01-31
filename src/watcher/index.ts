import { EventEmitter } from 'node:events';

import type { Config } from '../config/schema.js';
import type { Database } from '../db/index.js';
import { getErrorByHash, insertError, logActivity } from '../db/queries.js';
import { parseDuration } from '../utils/duration.js';
import type { ErrorStatus } from '../utils/errors.js';
import { Logger } from '../utils/logger.js';
import { ErrorParser, type ParsedError } from './parser.js';
import { CommandSource } from './sources/command.js';
import { DockerSource } from './sources/docker.js';
import { FileSource } from './sources/file.js';
import type { LogEvent, LogSource, LogSourceConfig } from './sources/types.js';

type SourceEntry = {
  name: string;
  source: LogSource;
};

export type WatcherDetectedEvent = {
  errorId: number;
  error: ParsedError;
  previousId?: number;
  previousStatus?: ErrorStatus;
};

export type WatcherDeduplicatedEvent = {
  errorId: number;
  error: ParsedError;
  status: ErrorStatus;
};

export type WatcherSourceErrorEvent = {
  source: string;
  error: Error;
};

type WatcherEventName = 'error_detected' | 'error_deduplicated' | 'source_error';

type WatcherEventPayloads = {
  error_detected: WatcherDetectedEvent;
  error_deduplicated: WatcherDeduplicatedEvent;
  source_error: WatcherSourceErrorEvent;
};

const ACTIVE_STATUSES = new Set<ErrorStatus>([
  'pending',
  'analyzing',
  'suggested',
  'fixing',
]);
const NO_SOURCE_WARN_INTERVAL_MS = 60_000;

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      if (resolver) {
        resolver({ value: undefined as T, done: true });
      }
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift() as T;
        continue;
      }
      if (this.closed) {
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }
}

class SerialTaskQueue {
  private pending: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.pending.then(() => task());
    this.pending = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

export class WatcherOrchestrator {
  private readonly config: Config;
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly sources: SourceEntry[] = [];
  private readonly eventQueue = new AsyncQueue<LogEvent>();
  private readonly parser: ErrorParser;
  private readonly emitter = new EventEmitter();
  private readonly errorQueue = new SerialTaskQueue();
  private processingPromise: Promise<void> | null = null;
  private started = false;
  private noSourceWarningTimer: NodeJS.Timeout | null = null;

  constructor(
    config: Config,
    db: Database,
    options?: {
      logger?: Logger;
    }
  ) {
    this.config = config;
    this.db = db;
    this.logger =
      options?.logger ?? new Logger({ rootDir: config.project.root });
    this.parser = new ErrorParser({
      contextLinesBefore: config.logs.context_lines_before,
      contextLinesAfter: config.logs.context_lines_after,
      customMatch: config.patterns.match,
      customIgnore: config.patterns.ignore,
      logger: this.logger,
      onError: (error) => this.queueErrorHandling(error),
    });
    this.createSources(config.logs.sources);
  }

  on<T extends WatcherEventName>(
    event: T,
    handler: (payload: WatcherEventPayloads[T]) => void
  ): void {
    this.emitter.on(event, handler);
  }

  emit(event: LogEvent): void {
    this.eventQueue.push(event);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.processingPromise = this.startEventProcessor();

    const results = await Promise.allSettled(
      this.sources.map((entry) => entry.source.start())
    );
    let startedCount = 0;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        startedCount += 1;
        return;
      }
      const entry = this.sources[index];
      const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      this.logger.error(
        `Failed to start log source '${entry.name}': ${error.message}`
      );
      this.emitter.emit('source_error', { source: entry.name, error });
    });

    if (startedCount === 0) {
      this.logger.error(
        'All log sources failed to start. Watcher will continue running.'
      );
      this.startNoSourceWarnings();
    } else {
      this.stopNoSourceWarnings();
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;

    this.stopNoSourceWarnings();

    await Promise.allSettled(
      this.sources.map((entry) => entry.source.stop())
    );
    this.eventQueue.close();
    if (this.processingPromise) {
      await this.processingPromise;
      this.processingPromise = null;
    }
  }

  private createSources(configs: LogSourceConfig[]): void {
    configs.forEach((config) => {
      const source = this.buildSource(config);
      source.on('line', (event) => this.eventQueue.push(event));
      this.sources.push({ name: config.name, source });
    });
  }

  private buildSource(config: LogSourceConfig): LogSource {
    switch (config.type) {
      case 'file':
        return new FileSource(config, { logger: this.logger });
      case 'docker':
        return new DockerSource(config, { logger: this.logger });
      case 'command':
        return new CommandSource(config, {
          logger: this.logger,
          maxLineBuffer: this.config.logs.max_line_buffer,
        });
      default: {
        const exhaustive: never = config;
        throw new Error(`Unsupported log source type: ${String(exhaustive)}`);
      }
    }
  }

  private async startEventProcessor(): Promise<void> {
    for await (const event of this.eventQueue) {
      try {
        await this.parser.processLine(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to process log event: ${message}`);
      }
    }
  }

  private queueErrorHandling(error: ParsedError): Promise<void> {
    return this.errorQueue.run(() => this.handleParsedError(error));
  }

  private async handleParsedError(error: ParsedError): Promise<void> {
    try {
      const existing = getErrorByHash(this.db, error.hash);
      if (existing && ACTIVE_STATUSES.has(existing.status)) {
        logActivity(
          this.db,
          'error_deduplicated',
          existing.id,
          `status=${existing.status}`
        );
        this.logger.info(
          `Deduplicated error ${error.hash} (status=${existing.status})`
        );
        this.emitter.emit('error_deduplicated', {
          errorId: existing.id,
          error,
          status: existing.status,
        } satisfies WatcherDeduplicatedEvent);
        return;
      }

      // Deduplicate fixed errors within grace period to prevent re-detection
      // after a fix when the log file is re-read
      if (existing && existing.status === 'fixed') {
        const gracePeriodMs = parseDuration(
          this.config.deduplication.fixed_grace_period
        );
        const fixedAt = new Date(existing.updatedAt).getTime();
        if (Date.now() - fixedAt < gracePeriodMs) {
          logActivity(
            this.db,
            'error_deduplicated',
            existing.id,
            `status=${existing.status} grace_period=true`
          );
          this.logger.info(
            `Deduplicated error ${error.hash} (within grace period after fix)`
          );
          this.emitter.emit('error_deduplicated', {
            errorId: existing.id,
            error,
            status: existing.status,
          } satisfies WatcherDeduplicatedEvent);
          return;
        }
      }

      const newId = insertError(this.db, {
        hash: error.hash,
        source: error.source,
        timestamp: error.timestamp,
        errorType: error.errorType,
        message: error.message,
        stackTrace: error.stackTrace,
        rawLog: error.rawLog,
        status: 'pending',
        fixAttempts: 0,
        suggestion: null,
        fixResult: null,
      });

      const details =
        existing ? `recurrence_of=${existing.id}` : undefined;
      logActivity(this.db, 'error_detected', newId, details);
      this.logger.info(
        existing
          ? `Recurring error detected (${newId}) from ${error.source}`
          : `New error detected (${newId}) from ${error.source}`
      );

      this.emitter.emit('error_detected', {
        errorId: newId,
        error,
        previousId: existing?.id,
        previousStatus: existing?.status,
      } satisfies WatcherDetectedEvent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to persist parsed error: ${message}`);
    }
  }

  private startNoSourceWarnings(): void {
    if (this.noSourceWarningTimer) {
      return;
    }
    this.noSourceWarningTimer = setInterval(() => {
      this.logger.warn('No log sources are running. Still waiting for sources.');
    }, NO_SOURCE_WARN_INTERVAL_MS);
  }

  private stopNoSourceWarnings(): void {
    if (!this.noSourceWarningTimer) {
      return;
    }
    clearInterval(this.noSourceWarningTimer);
    this.noSourceWarningTimer = null;
  }
}
