import type { NdjsonConfig } from './types.js';

export type ParsedNdjsonLine = {
  message: string;
  timestamp: Date;
};

export type NdjsonParseResult =
  | { success: true; data: ParsedNdjsonLine }
  | { success: false; reason: 'parse_error' | 'missing_message' | 'filtered' };

export function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

export function parseTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
    return null;
  }

  if (typeof value === 'number') {
    // Handle Unix timestamps in seconds or milliseconds
    // If the number is less than 10^12, treat as seconds; otherwise as milliseconds
    const MS_THRESHOLD = 1e12;
    const timestamp = value < MS_THRESHOLD ? value * 1000 : value;
    const date = new Date(timestamp);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
    return null;
  }

  return null;
}

export function shouldProcessLevel(
  value: unknown,
  levelFilter: string[] | undefined
): boolean {
  if (!levelFilter || levelFilter.length === 0) {
    return true;
  }

  if (value === null || value === undefined) {
    // If no level is present but filter is configured, skip the line
    return false;
  }

  // Handle string levels (most common)
  if (typeof value === 'string') {
    const lowerValue = value.toLowerCase();
    return levelFilter.some((filter) => filter.toLowerCase() === lowerValue);
  }

  // Handle numeric levels (Bunyan style: 10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal)
  if (typeof value === 'number') {
    const bunyanLevels: Record<number, string> = {
      10: 'trace',
      20: 'debug',
      30: 'info',
      40: 'warn',
      50: 'error',
      60: 'fatal',
    };
    const levelName = bunyanLevels[value];
    if (levelName) {
      return levelFilter.some(
        (filter) => filter.toLowerCase() === levelName.toLowerCase()
      );
    }
    // Unknown numeric level - don't match
    return false;
  }

  return false;
}

export function parseNdjsonLine(
  line: string,
  config: NdjsonConfig
): NdjsonParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { success: false, reason: 'parse_error' };
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { success: false, reason: 'parse_error' };
  }

  // Check level filter first (before extracting message)
  if (config.levelField) {
    const levelValue = getNestedValue(parsed, config.levelField);
    if (!shouldProcessLevel(levelValue, config.levelFilter)) {
      return { success: false, reason: 'filtered' };
    }
  }

  // Extract message
  const messageValue = getNestedValue(parsed, config.messageField);
  if (messageValue === null || messageValue === undefined) {
    return { success: false, reason: 'missing_message' };
  }

  const message = String(messageValue);

  // Extract timestamp
  let timestamp = new Date();
  if (config.timestampField) {
    const timestampValue = getNestedValue(parsed, config.timestampField);
    const parsedTimestamp = parseTimestamp(timestampValue);
    if (parsedTimestamp) {
      timestamp = parsedTimestamp;
    }
  }

  return {
    success: true,
    data: { message, timestamp },
  };
}
