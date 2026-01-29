import { describe, expect, it, vi } from 'vitest';

import { configSchema } from '../../src/config/schema.js';
import { generateAnalyzeContext, generateFixContext } from '../../src/fixer/context.js';
import type { ErrorRecord } from '../../src/db/queries.js';

const buildConfig = () =>
  configSchema.parse({
    project: { name: 'WatchFix Demo', root: '/tmp/project' },
    agent: { provider: 'codex' },
    logs: { sources: [{ name: 'app', type: 'file', path: '/tmp/app.log' }] },
  });

const baseError: ErrorRecord = {
  id: 5,
  hash: 'hash',
  source: 'app',
  timestamp: '2026-01-01T00:00:00.000Z',
  errorType: 'TypeError',
  message: 'TypeError: boom',
  stackTrace: '    at main (app.ts:10:5)',
  rawLog: [
    'before line',
    'TypeError: boom',
    '    at main (app.ts:10:5)',
    'after line',
  ].join('\n'),
  status: 'pending',
  suggestion: null,
  fixResult: null,
  fixAttempts: 1,
  lockedBy: null,
  lockedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('context generators', () => {
  it('generates analyze context with expected path and content', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T10:00:00.000Z'));

    const config = buildConfig();
    const result = generateAnalyzeContext(baseError, config, 2);

    expect(result.path).toBe(
      '.watchfix/context/2026-01-02-error-5-attempt-2-analyze.md'
    );
    expect(result.content).toContain('## Mode\nanalyze');
    expect(result.content).toContain(
      'Write your analysis to: `.watchfix/context/2026-01-02-error-5-attempt-2-analysis.yaml`'
    );
    expect(result.content).toContain('### Context (surrounding log lines)');
    expect(result.content).toContain('---ERROR---');
    expect(result.content).toContain('TypeError: boom');
    expect(result.content).toContain('---END ERROR---');

    vi.useRealTimers();
  });

  it('generates fix context with analysis content included', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-03T08:00:00.000Z'));

    const config = buildConfig();
    const analysis = 'summary: test summary';
    const result = generateFixContext(baseError, analysis, config, 3);

    expect(result.path).toBe(
      '.watchfix/context/2026-01-03-error-5-attempt-3-fix.md'
    );
    expect(result.content).toContain('## Mode\nfix');
    expect(result.content).toContain('## Previous Analysis');
    expect(result.content).toContain(analysis);
    expect(result.content).toContain(
      'Write your results to: `.watchfix/context/2026-01-03-error-5-attempt-3-result.yaml`'
    );

    vi.useRealTimers();
  });

  it('truncates stack trace and raw log context when size exceeds limit', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-04T00:00:00.000Z'));

    const config = buildConfig();
    config.cleanup.context_max_size_kb = 64;

    const stackLines = Array.from({ length: 6000 }, () => '    at call()');
    const stackTrace = stackLines.join('\n');
    const beforeLines = Array.from({ length: 3000 }, (_, index) =>
      `before-${index}-${'x'.repeat(40)}`
    );
    const rawLog = [
      ...beforeLines,
      'TypeError: boom',
      ...stackLines,
      'after line',
    ].join('\n');

    const largeError: ErrorRecord = {
      ...baseError,
      stackTrace,
      rawLog,
    };

    const result = generateAnalyzeContext(largeError, config, 1);

    expect(result.content).toContain('[...truncated...]');
    expect(result.content).toMatch(
      /\[\.\.\.\d+ lines truncated due to size limit\.\.\.\]/
    );
    expect(result.content).toContain('TypeError: boom');

    vi.useRealTimers();
  });

  it('ensures analyze context stays within the configured size limit', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T00:00:00.000Z'));

    const config = buildConfig();
    config.cleanup.context_max_size_kb = 1;

    const stackLines = Array.from({ length: 800 }, () => '    at call()');
    const stackTrace = stackLines.join('\n');
    const beforeLines = Array.from({ length: 400 }, (_, index) =>
      `before-${index}-${'x'.repeat(80)}`
    );
    const afterLines = Array.from({ length: 400 }, (_, index) =>
      `after-${index}-${'y'.repeat(80)}`
    );
    const rawLog = [
      ...beforeLines,
      'TypeError: boom',
      ...stackLines,
      ...afterLines,
    ].join('\n');

    const largeError: ErrorRecord = {
      ...baseError,
      stackTrace,
      rawLog,
    };

    const result = generateAnalyzeContext(largeError, config, 4);
    const maxBytes = config.cleanup.context_max_size_kb * 1024;

    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(
      maxBytes
    );

    vi.useRealTimers();
  });
});
