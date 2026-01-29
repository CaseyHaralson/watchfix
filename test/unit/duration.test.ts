import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  parseDuration,
} from '../../src/utils/duration.js';
import { UserError } from '../../src/utils/errors.js';

describe('parseDuration', () => {
  it('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
  });

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
  });

  it('throws UserError on invalid input', () => {
    expect(() => parseDuration('invalid')).toThrow(UserError);
  });
});

describe('formatDuration', () => {
  it('formats hours when divisible by an hour', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
  });

  it('formats minutes when divisible by a minute', () => {
    expect(formatDuration(300_000)).toBe('5m');
  });

  it('formats seconds when divisible by a second', () => {
    expect(formatDuration(30_000)).toBe('30s');
  });
});
