import { describe, expect, it } from 'vitest';
import {
  EXIT_CODES,
  ErrorStatus,
  InternalError,
  UserError,
} from '../../src/utils/errors.js';

describe('UserError', () => {
  it('sets name to UserError', () => {
    const err = new UserError('bad input');
    expect(err.name).toBe('UserError');
  });
});

describe('InternalError', () => {
  it('sets name to InternalError', () => {
    const err = new InternalError('boom');
    expect(err.name).toBe('InternalError');
  });

  it('preserves cause when provided', () => {
    const cause = new Error('root cause');
    const err = new InternalError('wrapped', { cause });
    expect((err as Error & { cause?: unknown }).cause).toBe(cause);
  });
});

describe('ErrorStatus', () => {
  it('accepts all defined status values', () => {
    const statuses = [
      'pending',
      'analyzing',
      'suggested',
      'fixing',
      'fixed',
      'failed',
      'ignored',
    ] as const satisfies ReadonlyArray<ErrorStatus>;

    expect(statuses).toHaveLength(7);
    expect(new Set(statuses).size).toBe(7);
  });
});

describe('EXIT_CODES', () => {
  it('matches specification values', () => {
    expect(EXIT_CODES.SUCCESS).toBe(0);
    expect(EXIT_CODES.GENERAL_ERROR).toBe(1);
    expect(EXIT_CODES.WATCHER_CONFLICT).toBe(2);
    expect(EXIT_CODES.NOT_ACTIONABLE).toBe(3);
    expect(EXIT_CODES.SCHEMA_MISMATCH).toBe(4);
    expect(EXIT_CODES.INTERRUPTED).toBe(130);
  });
});
