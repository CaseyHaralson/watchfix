import { describe, expect, it } from 'vitest';
import {
  extractErrorType,
  matchesErrorPattern,
} from '../../src/watcher/patterns.js';

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
