import { describe, expect, it } from 'vitest';
import { computeErrorHash, normalizeMessage } from '../../src/utils/hash.js';

describe('normalizeMessage', () => {
  it('removes ISO8601 timestamps', () => {
    const message =
      'Start 2026-01-28T12:34:56.789Z and 2026-01-29T03:04:05+02:00 end';
    expect(normalizeMessage(message)).toBe('Start and end');
  });

  it('removes UUIDs', () => {
    const message =
      'Failure id 123e4567-e89b-12d3-a456-426614174000 for request';
    expect(normalizeMessage(message)).toBe('Failure id for request');
  });

  it('removes 0x hex addresses', () => {
    const message = 'Pointer 0xDEADBEEF failed at 0xabc123';
    expect(normalizeMessage(message)).toBe('Pointer failed at');
  });

  it('collapses whitespace and trims', () => {
    const message = '  Something\n\nwent\twrong   here  ';
    expect(normalizeMessage(message)).toBe('Something went wrong here');
  });

  it('preserves case while normalizing', () => {
    const message =
      'ERROR 2026-01-28T12:34:56Z SomethingBAD 0xFEEDFACE';
    expect(normalizeMessage(message)).toBe('ERROR SomethingBAD');
  });
});

describe('computeErrorHash', () => {
  it('is stable for identical inputs', () => {
    const message = '2026-01-28T00:00:00Z Same failure';
    const hashA = computeErrorHash('watcher', 'RuntimeError', message);
    const hashB = computeErrorHash('watcher', 'RuntimeError', message);
    expect(hashA).toBe(hashB);
  });

  it('produces same hash for same error with different timestamps', () => {
    const base = 'Error for user';
    const messageA = `2026-01-28T00:00:00Z ${base}`;
    const messageB = `2026-01-29T12:30:15+02:00 ${base}`;

    const hashA = computeErrorHash('watcher', 'RuntimeError', messageA);
    const hashB = computeErrorHash('watcher', 'RuntimeError', messageB);

    expect(hashA).toBe(hashB);
  });

  it('produces different hashes for different error types', () => {
    const message = '2026-01-28T00:00:00Z Error happened';

    const hashA = computeErrorHash('watcher', 'TypeError', message);
    const hashB = computeErrorHash('watcher', 'ReferenceError', message);

    expect(hashA).not.toBe(hashB);
  });
});
