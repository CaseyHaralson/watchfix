import { describe, expect, it } from 'vitest';

import {
  parseAnalysisOutput,
  parseFixOutput,
} from '../../src/fixer/output.js';

describe('parseAnalysisOutput', () => {
  it('parses valid analysis output', () => {
    const yaml = `summary: PostgreSQL container not starting due to port conflict
root_cause: |
  Port 5432 is already bound by the host PostgreSQL service.
suggested_fix: |
  Change docker-compose.yaml port mapping from 5432:5432 to 5433:5432.
files_to_modify:
  - docker-compose.yaml
  - .env
confidence: high
`;

    const parsed = parseAnalysisOutput(yaml);

    expect(parsed.already_fixed).toBe(false);
    expect(parsed.summary).toContain('PostgreSQL');
    expect(parsed.files_to_modify).toEqual(['docker-compose.yaml', '.env']);
    expect(parsed.confidence).toBe('high');
  });

  it('parses already_fixed analysis output', () => {
    const yaml = `already_fixed: true
summary: The syntax error was already corrected by a previous fix
confidence: high
`;

    const parsed = parseAnalysisOutput(yaml);

    expect(parsed.already_fixed).toBe(true);
    expect(parsed.summary).toContain('already corrected');
    expect(parsed.root_cause).toBe('');
    expect(parsed.suggested_fix).toBe('');
    expect(parsed.files_to_modify).toEqual([]);
    expect(parsed.confidence).toBe('high');
  });

  it('throws when required fields are missing', () => {
    const yaml = `root_cause: missing summary
suggested_fix: fix it
files_to_modify:
  - app.ts
confidence: low
`;

    expect(() => parseAnalysisOutput(yaml)).toThrowError(/summary/);
  });

  it('throws when confidence is invalid', () => {
    const yaml = `summary: bad confidence
root_cause: unknown
suggested_fix: none
files_to_modify:
  - app.ts
confidence: maybe
`;

    expect(() => parseAnalysisOutput(yaml)).toThrowError(/confidence/i);
  });
});

describe('parseFixOutput', () => {
  it('parses valid fix output', () => {
    const yaml = `success: true
summary: Updated config
files_changed:
  - path: app.ts
    change: Updated config values
notes: |
  All good.
`;

    const parsed = parseFixOutput(yaml);

    expect(parsed.success).toBe(true);
    expect(parsed.summary).toBe('Updated config');
    expect(parsed.files_changed?.[0].path).toBe('app.ts');
  });

  it('throws when required fields are missing', () => {
    const yaml = `success: true
notes: missing summary
`;

    expect(() => parseFixOutput(yaml)).toThrowError(/summary/);
  });
});
