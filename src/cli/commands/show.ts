import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config/loader.js';
import { Database } from '../../db/index.js';
import { getError, type ErrorRecord } from '../../db/queries.js';
import { checkSchemaVersion, initializeSchema } from '../../db/schema.js';
import { UserError } from '../../utils/errors.js';

type ShowOptions = {
  config?: string;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
};

type ActivityLogEntry = {
  id: number;
  timestamp: string;
  action: string;
  error_id: number | null;
  details: string | null;
};

type AnalysisResult = {
  summary?: string;
  root_cause?: string;
  suggested_fix?: string;
  files_to_modify?: string[];
  confidence?: string;
};

type FixResult = {
  success?: boolean;
  summary?: string;
  files_changed?: { path: string; change: string }[];
  notes?: string;
};

const buildDatabasePath = (rootDir: string): string =>
  path.join(rootDir, '.watchfix', 'errors.db');

const parsePositiveInt = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UserError('Error id must be a positive integer.');
  }
  return parsed;
};

const parseJsonMaybe = <T>(value: string | null): T | string | null => {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return value;
  }
};

const getActivityLog = (db: Database, errorId: number): ActivityLogEntry[] =>
  db.all<ActivityLogEntry>(
    'SELECT id, timestamp, action, error_id, details FROM activity_log WHERE error_id = ? ORDER BY timestamp ASC, id ASC',
    [errorId]
  );

const formatMultiline = (label: string, value?: string | null): string[] => {
  if (!value) {
    return [`${label}: (none)`];
  }
  const lines = value.split('\n');
  return [`${label}:`, ...lines.map((line) => `  ${line}`)];
};

const formatErrorDetails = (error: ErrorRecord): string[] => [
  `ID: ${error.id}`,
  `Hash: ${error.hash}`,
  `Source: ${error.source}`,
  `Timestamp: ${error.timestamp}`,
  `Error type: ${error.errorType}`,
  `Message: ${error.message}`,
  `Status: ${error.status}`,
  `Fix attempts: ${error.fixAttempts}`,
  `Locked by: ${error.lockedBy ?? '(none)'}`,
  `Locked at: ${error.lockedAt ?? '(none)'}`,
  `Created at: ${error.createdAt}`,
  `Updated at: ${error.updatedAt}`,
  `Suggestion (raw): ${error.suggestion ?? '(none)'}`,
  `Fix result (raw): ${error.fixResult ?? '(none)'}`,
];

const formatAnalysis = (analysis: AnalysisResult | string | null): string[] => {
  if (!analysis) {
    return ['Analysis: (none)'];
  }
  if (typeof analysis === 'string') {
    return ['Analysis (raw):', `  ${analysis}`];
  }

  const lines = ['Analysis:'];
  if (analysis.summary) {
    lines.push(`  Summary: ${analysis.summary}`);
  }
  if (analysis.root_cause) {
    lines.push('  Root cause:');
    lines.push(...analysis.root_cause.split('\n').map((line) => `    ${line}`));
  }
  if (analysis.suggested_fix) {
    lines.push('  Suggested fix:');
    lines.push(
      ...analysis.suggested_fix.split('\n').map((line) => `    ${line}`)
    );
  }
  if (analysis.files_to_modify && analysis.files_to_modify.length > 0) {
    lines.push('  Files to modify:');
    for (const file of analysis.files_to_modify) {
      lines.push(`    - ${file}`);
    }
  }
  if (analysis.confidence) {
    lines.push(`  Confidence: ${analysis.confidence}`);
  }
  if (lines.length === 1) {
    lines.push('  (empty)');
  }
  return lines;
};

const formatFixResult = (result: FixResult | string | null): string[] => {
  if (!result) {
    return ['Fix result: (none)'];
  }
  if (typeof result === 'string') {
    return ['Fix result (raw):', `  ${result}`];
  }

  const lines = ['Fix result:'];
  if (typeof result.success === 'boolean') {
    lines.push(`  Success: ${result.success ? 'true' : 'false'}`);
  }
  if (result.summary) {
    lines.push(`  Summary: ${result.summary}`);
  }
  if (result.files_changed && result.files_changed.length > 0) {
    lines.push('  Files changed:');
    for (const file of result.files_changed) {
      lines.push(`    - ${file.path}: ${file.change}`);
    }
  }
  if (result.notes) {
    lines.push('  Notes:');
    lines.push(...result.notes.split('\n').map((line) => `    ${line}`));
  }
  if (lines.length === 1) {
    lines.push('  (empty)');
  }
  return lines;
};

const formatActivityLog = (entries: ActivityLogEntry[]): string[] => {
  if (entries.length === 0) {
    return ['Activity log: (none)'];
  }
  const lines = ['Activity log:'];
  for (const entry of entries) {
    const details = entry.details ? ` - ${entry.details}` : '';
    lines.push(
      `  [${entry.timestamp}] ${entry.action}${details}`.trimEnd()
    );
  }
  return lines;
};

export const showCommand = async (
  id: string,
  options: ShowOptions
): Promise<void> => {
  const errorId = parsePositiveInt(id);
  const config = loadConfig(options.config);
  const dbPath = buildDatabasePath(config.project.root);

  if (!fs.existsSync(dbPath)) {
    throw new UserError(
      `No database found at ${dbPath}. Run watchfix watch to create it.`
    );
  }

  const db = new Database(dbPath);
  try {
    initializeSchema(db);
    checkSchemaVersion(db);

    const error = getError(db, errorId);
    if (!error) {
      throw new UserError(`Error #${errorId} not found.`);
    }

    const analysis = parseJsonMaybe<AnalysisResult>(error.suggestion);
    const fixResult = parseJsonMaybe<FixResult>(error.fixResult);
    const activityLog = getActivityLog(db, errorId);

    if (options.json) {
      const payload = {
        error,
        analysis,
        fixResult,
        activityLog,
      };
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }

    const lines: string[] = [];
    lines.push(`Error #${error.id}`);
    lines.push(...formatErrorDetails(error));
    lines.push(...formatMultiline('Stack trace', error.stackTrace));
    lines.push(...formatMultiline('Raw log', error.rawLog));
    lines.push(...formatAnalysis(analysis));
    lines.push(...formatFixResult(fixResult));
    lines.push(...formatActivityLog(activityLog));
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    db.close();
  }
};
