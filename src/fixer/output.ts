import yaml from 'yaml';

import { UserError } from '../utils/errors.js';

type ConfidenceLevel = 'high' | 'medium' | 'low';

type ErrorCategory = 'code' | 'infrastructure' | 'configuration';

type AnalysisOutput = {
  already_fixed: boolean;
  summary: string;
  root_cause: string;
  suggested_fix: string;
  files_to_modify: string[];
  confidence: ConfidenceLevel;
  category?: ErrorCategory;
  remediation_guidance?: string;
};

type FixOutput = {
  success: boolean;
  summary: string;
  files_changed?: Array<{ path: string; change: string }>;
  notes?: string;
};

type StoredFixResult = {
  fix?: FixOutput;
  verification_failure?: {
    type: 'command' | 'health_check';
    command?: string;
    message?: string;
    stderr?: string;
  };
  error?: boolean;
  diagnostic?: string;
};

const parseYaml = (content: string): unknown => {
  try {
    return yaml.parse(content);
  } catch (error) {
    const err = error as Error;
    throw new UserError(
      `Failed to parse YAML output: ${err.message ?? String(err)}`
    );
  }
};

const assertRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UserError('Invalid agent output: expected a YAML object');
  }
  return value as Record<string, unknown>;
};

const requireStringField = (
  data: Record<string, unknown>,
  field: string
): string => {
  const value = data[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UserError(`Missing required field: ${field}`);
  }
  return value;
};

const requireBooleanField = (
  data: Record<string, unknown>,
  field: string
): boolean => {
  const value = data[field];
  if (typeof value !== 'boolean') {
    throw new UserError(`Missing required field: ${field}`);
  }
  return value;
};

const requireStringArrayField = (
  data: Record<string, unknown>,
  field: string
): string[] => {
  const value = data[field];
  if (!Array.isArray(value)) {
    throw new UserError(`Missing required field: ${field}`);
  }
  const strings = value.filter((entry) => typeof entry === 'string');
  if (strings.length !== value.length) {
    throw new UserError(`Invalid field: ${field} must be an array of strings`);
  }
  return strings;
};

const validateFilesChanged = (value: unknown): FixOutput['files_changed'] => {
  if (!Array.isArray(value)) {
    throw new UserError(
      'Invalid field: files_changed must be an array of { path, change }'
    );
  }
  const mapped = value.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry)
    ) {
      throw new UserError(
        'Invalid field: files_changed must be an array of { path, change }'
      );
    }
    const record = entry as Record<string, unknown>;
    const path = record.path;
    const change = record.change;
    if (typeof path !== 'string' || typeof change !== 'string') {
      throw new UserError(
        'Invalid field: files_changed must be an array of { path, change }'
      );
    }
    return { path, change };
  });
  return mapped.length > 0 ? mapped : undefined;
};

const validateConfidence = (value: unknown): ConfidenceLevel => {
  if (value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  throw new UserError(
    `Invalid confidence value: ${value ?? 'undefined'} (expected high|medium|low)`
  );
};

const validateCategory = (value: unknown): ErrorCategory => {
  if (value === 'code' || value === 'infrastructure' || value === 'configuration') {
    return value;
  }
  throw new UserError(
    `Invalid category value: ${value ?? 'undefined'} (expected code|infrastructure|configuration)`
  );
};

const parseAnalysisOutput = (content: string): AnalysisOutput => {
  const raw = parseYaml(content);
  const data = assertRecord(raw);

  const already_fixed = data.already_fixed === true;
  const summary = requireStringField(data, 'summary');
  const confidence = validateConfidence(data.confidence);

  // Parse category, defaulting to 'code' if not specified (backwards compat)
  const category: ErrorCategory = data.category !== undefined
    ? validateCategory(data.category)
    : 'code';

  // Parse remediation_guidance if present
  let remediation_guidance: string | undefined;
  if (data.remediation_guidance !== undefined) {
    if (typeof data.remediation_guidance !== 'string') {
      throw new UserError('Invalid field: remediation_guidance must be a string');
    }
    remediation_guidance = data.remediation_guidance;
  }

  if (already_fixed) {
    return {
      already_fixed: true,
      summary,
      root_cause: '',
      suggested_fix: '',
      files_to_modify: [],
      confidence,
      category,
      remediation_guidance,
    };
  }

  // For non-code categories, require remediation_guidance but allow empty files_to_modify
  if (category !== 'code') {
    if (!remediation_guidance || remediation_guidance.trim() === '') {
      throw new UserError(
        `Missing required field: remediation_guidance (required for ${category} errors)`
      );
    }
    // files_to_modify can be empty for non-code errors
    const files_to_modify = data.files_to_modify !== undefined
      ? requireStringArrayField(data, 'files_to_modify')
      : [];

    return {
      already_fixed: false,
      summary,
      root_cause: typeof data.root_cause === 'string' ? data.root_cause : '',
      suggested_fix: typeof data.suggested_fix === 'string' ? data.suggested_fix : '',
      files_to_modify,
      confidence,
      category,
      remediation_guidance,
    };
  }

  // For code category, require root_cause, suggested_fix, files_to_modify
  const root_cause = requireStringField(data, 'root_cause');
  const suggested_fix = requireStringField(data, 'suggested_fix');
  const files_to_modify = requireStringArrayField(data, 'files_to_modify');

  return {
    already_fixed: false,
    summary,
    root_cause,
    suggested_fix,
    files_to_modify,
    confidence,
    category,
    remediation_guidance,
  };
};

const parseFixOutput = (content: string): FixOutput => {
  const raw = parseYaml(content);
  const data = assertRecord(raw);

  const success = requireBooleanField(data, 'success');
  const summary = requireStringField(data, 'summary');

  let files_changed: FixOutput['files_changed'];
  if (data.files_changed !== undefined) {
    files_changed = validateFilesChanged(data.files_changed);
  }

  let notes: FixOutput['notes'];
  if (data.notes !== undefined) {
    if (typeof data.notes !== 'string') {
      throw new UserError('Invalid field: notes must be a string');
    }
    notes = data.notes;
  }

  return {
    success,
    summary,
    files_changed,
    notes,
  };
};

export type { AnalysisOutput, FixOutput, ConfidenceLevel, ErrorCategory, StoredFixResult };
export { parseAnalysisOutput, parseFixOutput };
