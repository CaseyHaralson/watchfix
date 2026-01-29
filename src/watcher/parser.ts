import { computeErrorHash } from '../utils/hash.js';
import { extractErrorType, matchesErrorPattern } from './patterns.js';
import type { Logger } from '../utils/logger.js';

export type LogEvent = {
  source: string;
  line: string;
  timestamp: Date;
};

export type ParsedError = {
  source: string;
  timestamp: string;
  errorType: string;
  message: string;
  stackTrace: string | null;
  rawLog: string;
  hash: string;
};

type ErrorBuffer = {
  source: string;
  timestamp: Date;
  message: string;
  errorType: string;
  rawLines: string[];
  stackLines: string[];
  phase: 'stack' | 'after';
  afterRemaining: number;
};

const MAX_LINE_LENGTH = 64 * 1024;
const TRUNCATION_SUFFIX = '... [truncated]';
const FLUSH_TIMEOUT_MS = 100;

const CONTINUATION_PATTERNS: ReadonlyArray<RegExp> = [
  /^at\s/,
  /^\s+(at|in)\s/,
  /^\s+File "/,
  /^\s+\d+:\d+/,
  /^\s+\.\.\./,
];

const isContinuationLine = (line: string): boolean =>
  CONTINUATION_PATTERNS.some((pattern) => pattern.test(line));

const truncateLine = (line: string): string => {
  if (line.length <= MAX_LINE_LENGTH) {
    return line;
  }
  return `${line.slice(0, MAX_LINE_LENGTH)}${TRUNCATION_SUFFIX}`;
};

export class ErrorParser {
  private readonly contextLinesBefore: number;
  private readonly contextLinesAfter: number;
  private readonly onError: (error: ParsedError) => void | Promise<void>;
  private readonly customMatch?: string[];
  private readonly customIgnore?: string[];
  private readonly logger?: Logger;
  private readonly flushTimeoutMs: number;
  private beforeBuffer: string[] = [];
  private current?: ErrorBuffer;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lastSource?: string;

  constructor(options?: {
    contextLinesBefore?: number;
    contextLinesAfter?: number;
    onError?: (error: ParsedError) => void | Promise<void>;
    customMatch?: string[];
    customIgnore?: string[];
    logger?: Logger;
    flushTimeoutMs?: number;
  }) {
    this.contextLinesBefore = options?.contextLinesBefore ?? 10;
    this.contextLinesAfter = options?.contextLinesAfter ?? 5;
    this.onError = options?.onError ?? (() => undefined);
    this.customMatch = options?.customMatch;
    this.customIgnore = options?.customIgnore;
    this.logger = options?.logger;
    this.flushTimeoutMs = options?.flushTimeoutMs ?? FLUSH_TIMEOUT_MS;
  }

  async processLine(event: LogEvent): Promise<void> {
    if (this.lastSource && this.lastSource !== event.source) {
      if (this.current) {
        await this.flushCurrent('source_change');
      }
      this.beforeBuffer = [];
    }
    this.lastSource = event.source;

    const line = truncateLine(event.line);
    const isError = matchesErrorPattern(
      line,
      this.customMatch,
      this.customIgnore
    );

    if (!this.current) {
      if (isError) {
        this.startError(event, line);
      } else {
        this.recordBeforeContext(line);
      }
      return;
    }

    if (isError) {
      await this.flushCurrent('new_error');
      this.startError(event, line);
      return;
    }

    if (this.current.phase === 'stack') {
      if (isContinuationLine(line)) {
        this.current.stackLines.push(line);
        this.current.rawLines.push(line);
        this.resetFlushTimer();
        return;
      }

      if (this.contextLinesAfter === 0) {
        await this.flushCurrent('after_complete');
        this.recordBeforeContext(line);
        return;
      }

      this.current.phase = 'after';
      this.current.afterRemaining = this.contextLinesAfter;
      this.current.rawLines.push(line);
      this.recordBeforeContext(line);
      this.current.afterRemaining -= 1;
      this.resetFlushTimer();
      if (this.current.afterRemaining <= 0) {
        await this.flushCurrent('after_complete');
      }
      return;
    }

    this.current.rawLines.push(line);
    this.recordBeforeContext(line);
    this.current.afterRemaining -= 1;
    this.resetFlushTimer();
    if (this.current.afterRemaining <= 0) {
      await this.flushCurrent('after_complete');
    }
  }

  private startError(event: LogEvent, line: string): void {
    const contextBefore =
      this.contextLinesBefore > 0 ? [...this.beforeBuffer] : [];
    this.beforeBuffer = [];

    const errorType = extractErrorType(line);
    this.current = {
      source: event.source,
      timestamp: event.timestamp,
      message: line,
      errorType,
      rawLines: [...contextBefore, line],
      stackLines: [],
      phase: 'stack',
      afterRemaining: this.contextLinesAfter,
    };

    this.resetFlushTimer();
  }

  private recordBeforeContext(line: string): void {
    if (this.contextLinesBefore === 0) {
      return;
    }
    this.beforeBuffer.push(line);
    if (this.beforeBuffer.length > this.contextLinesBefore) {
      this.beforeBuffer.shift();
    }
  }

  private resetFlushTimer(): void {
    if (!this.current) {
      return;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      void this.flushCurrent('timeout');
    }, this.flushTimeoutMs);
  }

  private async flushCurrent(reason: string): Promise<void> {
    if (!this.current) {
      return;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    const current = this.current;
    this.current = undefined;

    const stackTrace =
      current.stackLines.length > 0 ? current.stackLines.join('\n') : null;
    const rawLog = current.rawLines.join('\n');
    const hash = computeErrorHash(
      current.source,
      current.errorType,
      current.message
    );

    try {
      await this.onError({
        source: current.source,
        timestamp: current.timestamp.toISOString(),
        errorType: current.errorType,
        message: current.message,
        stackTrace,
        rawLog,
        hash,
      });
    } catch (error) {
      if (this.logger) {
        this.logger.error(
          `ErrorParser failed to emit error (${reason}): ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        );
      }
    }
  }
}
