import { describe, expect, it, vi } from 'vitest';
import {
  extractErrorType,
  matchesErrorPattern,
} from '../../src/watcher/patterns.js';
import { ErrorParser, type ParsedError } from '../../src/watcher/parser.js';

describe('matchesErrorPattern', () => {
  it('detects built-in error patterns', () => {
    expect(matchesErrorPattern('TypeError: boom')).toBe(true);
    expect(matchesErrorPattern('connect ECONNREFUSED 127.0.0.1')).toBe(true);
    expect(matchesErrorPattern('panic: runtime error: index out of range')).toBe(
      true
    );
  });

  it('ignores log levels at line start', () => {
    expect(matchesErrorPattern('DEBUG TypeError: boom')).toBe(false);
    expect(matchesErrorPattern('INFO: ECONNREFUSED')).toBe(false);
  });

  it('respects custom patterns with regex support', () => {
    expect(
      matchesErrorPattern('Circuit Breaker Open', ['circuit breaker open'])
    ).toBe(true);
    expect(
      matchesErrorPattern('timeout after 10s', ['regex:timeout after \\d+s'])
    ).toBe(true);
  });

  it('ensures ignore patterns take precedence over match patterns', () => {
    expect(
      matchesErrorPattern(
        'error timeout after 5s',
        ['error'],
        ['regex:timeout']
      )
    ).toBe(false);
  });
});

describe('extractErrorType', () => {
  it('extracts known error types', () => {
    expect(extractErrorType('TypeError: bad')).toBe('TypeError');
    expect(extractErrorType('NullPointerException: bad')).toBe(
      'NullPointerException'
    );
    expect(extractErrorType('connect ECONNREFUSED 127.0.0.1')).toBe(
      'ECONNREFUSED'
    );
    expect(extractErrorType('panic: runtime error')).toBe('panic');
    expect(extractErrorType('FATAL: bad things')).toBe('FATAL');
    expect(extractErrorType('SQLSTATE[23505] duplicate key')).toBe('23505');
  });

  it('falls back to Error when no match exists', () => {
    expect(extractErrorType('something went wrong')).toBe('Error');
  });
});

describe('ErrorParser', () => {
  const timestamp = new Date('2025-01-01T00:00:00.000Z');

  const emitEvents = async (
    parser: ErrorParser,
    lines: string[]
  ): Promise<void> => {
    for (const line of lines) {
      await parser.processLine({
        source: 'app',
        line,
        timestamp,
      });
    }
  };

  it('discards generic error when followed by specific error with same message', async () => {
    vi.useFakeTimers();
    const parsed: ParsedError[] = [];
    const parser = new ErrorParser({
      contextLinesBefore: 0,
      contextLinesAfter: 0,
      flushTimeoutMs: 10,
      onError: (error) => {
        parsed.push(error);
      },
    });

    // Simulate logs where a generic "Error:" is followed by a specific "TypeError:"
    // with the same core message - only the specific one should be emitted
    await emitEvents(parser, [
      'Error: Cannot read property of undefined',
      'TypeError: Cannot read property of undefined',
      '    at foo (file.js:1:1)',
    ]);

    await vi.advanceTimersByTimeAsync(15);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].errorType).toBe('TypeError');
    expect(parsed[0].message).toBe('TypeError: Cannot read property of undefined');
    vi.useRealTimers();
  });

  it('emits both errors when they have different core messages', async () => {
    vi.useFakeTimers();
    const parsed: ParsedError[] = [];
    const parser = new ErrorParser({
      contextLinesBefore: 0,
      contextLinesAfter: 0,
      flushTimeoutMs: 10,
      onError: (error) => {
        parsed.push(error);
      },
    });

    // Different core messages should result in two separate errors
    await emitEvents(parser, [
      'Error: First problem',
      'TypeError: Different problem',
    ]);

    await vi.advanceTimersByTimeAsync(15);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].errorType).toBe('Error');
    expect(parsed[1].errorType).toBe('TypeError');
    vi.useRealTimers();
  });

  it('groups stack traces and captures context after stack end', async () => {
    const parsed: ParsedError[] = [];
    const parser = new ErrorParser({
      contextLinesBefore: 2,
      contextLinesAfter: 2,
      onError: (error) => {
        parsed.push(error);
      },
    });

    await emitEvents(parser, [
      'before one',
      'before two',
      'TypeError: boom',
      '    at first (file.js:1:1)',
      '    at second (file.js:2:2)',
      'after one',
      'after two',
    ]);

    expect(parsed).toHaveLength(1);
    const [error] = parsed;
    expect(error.message).toBe('TypeError: boom');
    expect(error.stackTrace).toBe(
      ['    at first (file.js:1:1)', '    at second (file.js:2:2)'].join('\n')
    );
    expect(error.rawLog.split('\n')).toEqual([
      'before one',
      'before two',
      'TypeError: boom',
      '    at first (file.js:1:1)',
      '    at second (file.js:2:2)',
      'after one',
      'after two',
    ]);
  });

  it('truncates long lines and flushes on timeout', async () => {
    vi.useFakeTimers();
    const parsed: ParsedError[] = [];
    const parser = new ErrorParser({
      contextLinesBefore: 0,
      contextLinesAfter: 0,
      flushTimeoutMs: 10,
      onError: (error) => {
        parsed.push(error);
      },
    });

    const longLine = `TypeError: ${'a'.repeat(70_000)}`;
    await parser.processLine({
      source: 'app',
      line: longLine,
      timestamp,
    });

    await vi.advanceTimersByTimeAsync(15);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].message.endsWith('... [truncated]')).toBe(true);
    vi.useRealTimers();
  });
});
