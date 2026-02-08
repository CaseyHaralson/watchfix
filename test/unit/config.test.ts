import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';

const minimalConfig = {
  project: { name: 'my-app' },
  agent: { provider: 'claude' },
  logs: {
    sources: [
      {
        name: 'backend',
        type: 'file',
        path: './logs/backend.log',
      },
    ],
  },
};

describe('configSchema', () => {
  it('accepts a valid config', () => {
    const result = configSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
  });

  it('rejects invalid duration strings', () => {
    const result = configSchema.safeParse({
      ...minimalConfig,
      agent: { provider: 'claude', timeout: '25h' },
    });

    expect(result.success).toBe(false);
  });

  it('rejects missing required fields with clear errors', () => {
    const result = configSchema.safeParse({});

    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.join(' ')).toContain('Required');
    }
  });

  it('applies default values', () => {
    const result = configSchema.parse(minimalConfig);

    expect(result.project.root).toBe('.');
    expect(result.agent.timeout).toBe('5m');
    expect(result.agent.retries).toBe(2);
    expect(result.logs.context_lines_before).toBe(10);
    expect(result.logs.context_lines_after).toBe(5);
    expect(result.logs.max_line_buffer).toBe(10000);
    expect(result.verification.test_commands).toEqual([]);
    expect(result.verification.test_command_timeout).toBe('5m');
    expect(result.verification.health_checks).toEqual([]);
    expect(result.verification.health_check_timeout).toBe('10s');
    expect(result.verification.wait_after_fix).toBe('5s');
    expect(result.limits.max_attempts_per_error).toBe(3);
    expect(result.cleanup.context_max_age_days).toBe(7);
    expect(result.cleanup.context_max_size_kb).toBe(256);
    expect(result.patterns.match).toEqual([]);
    expect(result.patterns.ignore).toEqual([]);
  });

  it('requires unique log source names', () => {
    const result = configSchema.safeParse({
      ...minimalConfig,
      logs: {
        sources: [
          {
            name: 'backend',
            type: 'file',
            path: './logs/backend.log',
          },
          {
            name: 'backend',
            type: 'docker',
            container: 'my-app-api',
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        'Log source names must be unique'
      );
    }
  });

  it('accepts file source with ndjson format and config', () => {
    const result = configSchema.safeParse({
      ...minimalConfig,
      logs: {
        sources: [
          {
            name: 'app',
            type: 'file',
            path: './logs/app.log',
            format: 'ndjson',
            ndjson: {
              messageField: 'msg',
              timestampField: 'time',
              levelField: 'level',
              levelFilter: ['error', 'fatal'],
            },
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects ndjson format without ndjson config', () => {
    const result = configSchema.safeParse({
      ...minimalConfig,
      logs: {
        sources: [
          {
            name: 'app',
            type: 'file',
            path: './logs/app.log',
            format: 'ndjson',
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        'ndjson config is required when format is "ndjson"'
      );
    }
  });

  it('accepts file source without format (defaults to text)', () => {
    const result = configSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
  });
});
