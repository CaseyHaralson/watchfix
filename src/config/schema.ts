import { z } from 'zod';

const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

const durationSchema = z
  .string()
  .regex(
    /^\d+[smh]$/,
    'Duration must be a number followed by s, m, or h (e.g., "5m", "30s", "1h")'
  )
  .refine((value) => {
    const amount = Number.parseInt(value.slice(0, -1), 10);
    return amount > 0;
  }, 'Duration must be greater than 0')
  .refine((value) => {
    const amount = Number.parseInt(value.slice(0, -1), 10);
    const unit = value.slice(-1) as 's' | 'm' | 'h';
    const msByUnit: Record<typeof unit, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
    };
    return amount * msByUnit[unit] <= MAX_DURATION_MS;
  }, 'Duration cannot exceed 24 hours');

const ndjsonConfigSchema = z.object({
  messageField: z.string().min(1),
  timestampField: z.string().min(1).optional(),
  levelField: z.string().min(1).optional(),
  levelFilter: z.array(z.string().min(1)).optional(),
});

const fileSourceSchema = z.object({
  name: z.string().min(1),
  type: z.literal('file'),
  path: z.string().min(1),
  format: z.enum(['text', 'ndjson']).optional(),
  ndjson: ndjsonConfigSchema.optional(),
});

const dockerSourceSchema = z.object({
  name: z.string().min(1),
  type: z.literal('docker'),
  container: z.string().min(1),
});

const commandSourceSchema = z.object({
  name: z.string().min(1),
  type: z.literal('command'),
  run: z.string().min(1),
  interval: durationSchema,
});

const logSourceSchema = z.discriminatedUnion('type', [
  fileSourceSchema,
  dockerSourceSchema,
  commandSourceSchema,
]);

const patternSchema = z.string().min(1);

const configSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    root: z.string().default('.'),
  }),
  agent: z.object({
    provider: z.enum(['claude', 'gemini', 'codex']),
    timeout: durationSchema.default('5m'),
    retries: z.number().int().min(0).default(2),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    stderr_is_progress: z.boolean().optional(),
  }),
  logs: z.object({
    sources: z
      .array(logSourceSchema)
      .min(1)
      .refine(
        (sources) => {
          const names = sources.map((source) => source.name);
          return names.length === new Set(names).size;
        },
        { message: 'Log source names must be unique' }
      )
      .refine(
        (sources) => {
          return sources.every((source) => {
            if (source.type === 'file' && source.format === 'ndjson') {
              return source.ndjson !== undefined;
            }
            return true;
          });
        },
        { message: 'ndjson config is required when format is "ndjson"' }
      ),
    context_lines_before: z.number().int().min(0).default(10),
    context_lines_after: z.number().int().min(0).default(5),
    max_line_buffer: z.number().int().min(100).default(10000),
  }),
  verification: z
    .object({
      test_commands: z.array(z.string()).default([]),
      test_command_timeout: durationSchema.default('5m'),
      health_checks: z
        .array(
          z
            .string()
            .url()
            .refine(
              (url) => url.startsWith('http://') || url.startsWith('https://'),
              { message: 'Health check URL must use http:// or https://' }
            )
        )
        .default([]),
      health_check_timeout: durationSchema.default('10s'),
      wait_after_fix: durationSchema.default('5s'),
    })
    .default({}),
  limits: z
    .object({
      max_attempts_per_error: z.number().int().min(1).default(3),
    })
    .default({}),
  cleanup: z
    .object({
      context_max_age_days: z.number().int().min(1).default(7),
      context_max_size_kb: z.number().int().min(64).default(256),
    })
    .default({}),
  deduplication: z
    .object({
      fixed_grace_period: durationSchema.default('10m'),
      deferred_grace_period: durationSchema.default('1h'),
    })
    .default({}),
  patterns: z
    .object({
      match: z.array(patternSchema).default([]),
      ignore: z.array(patternSchema).default([]),
    })
    .default({}),
});

type Config = z.infer<typeof configSchema>;

export {
  commandSourceSchema,
  configSchema,
  dockerSourceSchema,
  durationSchema,
  fileSourceSchema,
  logSourceSchema,
  ndjsonConfigSchema,
  patternSchema,
};
export type { Config };
