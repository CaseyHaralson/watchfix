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

  it('parses code category analysis (default)', () => {
    const yaml = `summary: Type mismatch in comparison
root_cause: |
  Comparing string to number without conversion.
suggested_fix: |
  Convert id to number before comparison.
files_to_modify:
  - src/handlers/user.ts
confidence: high
`;

    const parsed = parseAnalysisOutput(yaml);

    expect(parsed.category).toBe('code');
    expect(parsed.already_fixed).toBe(false);
    expect(parsed.files_to_modify).toEqual(['src/handlers/user.ts']);
  });

  it('parses explicit code category analysis', () => {
    const yaml = `category: code
summary: Null pointer exception
root_cause: Missing null check
suggested_fix: Add null check
files_to_modify:
  - src/app.ts
confidence: high
`;

    const parsed = parseAnalysisOutput(yaml);

    expect(parsed.category).toBe('code');
    expect(parsed.already_fixed).toBe(false);
  });

  it('parses infrastructure category analysis', () => {
    const yaml = `category: infrastructure
summary: Database connection refused
remediation_guidance: |
  The PostgreSQL database is not running.
  Start it with: docker-compose up -d postgres
confidence: high
`;

    const parsed = parseAnalysisOutput(yaml);

    expect(parsed.category).toBe('infrastructure');
    expect(parsed.already_fixed).toBe(false);
    expect(parsed.summary).toContain('Database connection refused');
    expect(parsed.remediation_guidance).toContain('docker-compose up');
    expect(parsed.files_to_modify).toEqual([]);
  });

  it('parses configuration category analysis', () => {
    const yaml = `category: configuration
summary: Missing DATABASE_URL environment variable
remediation_guidance: |
  Set the DATABASE_URL environment variable in your .env file:
  DATABASE_URL=postgres://user:pass@localhost:5432/db
confidence: high
`;

    const parsed = parseAnalysisOutput(yaml);

    expect(parsed.category).toBe('configuration');
    expect(parsed.summary).toContain('DATABASE_URL');
    expect(parsed.remediation_guidance).toContain('.env file');
  });

  it('throws when infrastructure category missing remediation_guidance', () => {
    const yaml = `category: infrastructure
summary: Redis unavailable
confidence: high
`;

    expect(() => parseAnalysisOutput(yaml)).toThrowError(/remediation_guidance/);
  });

  it('throws when configuration category missing remediation_guidance', () => {
    const yaml = `category: configuration
summary: Invalid config value
confidence: medium
`;

    expect(() => parseAnalysisOutput(yaml)).toThrowError(/remediation_guidance/);
  });

  it('throws when category is invalid', () => {
    const yaml = `category: network
summary: Some issue
confidence: low
`;

    expect(() => parseAnalysisOutput(yaml)).toThrowError(/category/i);
  });

  it('allows empty files_to_modify for non-code categories', () => {
    const yaml = `category: infrastructure
summary: Service unavailable
remediation_guidance: Restart the service
confidence: high
`;

    const parsed = parseAnalysisOutput(yaml);

    expect(parsed.files_to_modify).toEqual([]);
  });

  it('allows files_to_modify for non-code categories', () => {
    const yaml = `category: configuration
summary: Config file has wrong value
remediation_guidance: |
  Update the config file directly
files_to_modify:
  - config/settings.json
confidence: medium
`;

    const parsed = parseAnalysisOutput(yaml);

    expect(parsed.files_to_modify).toEqual(['config/settings.json']);
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
