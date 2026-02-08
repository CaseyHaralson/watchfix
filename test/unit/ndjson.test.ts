import { describe, expect, it } from 'vitest';
import {
  getNestedValue,
  parseTimestamp,
  shouldProcessLevel,
  parseNdjsonLine,
} from '../../src/watcher/sources/ndjson.js';

describe('getNestedValue', () => {
  it('returns top-level field value', () => {
    const obj = { msg: 'hello' };
    expect(getNestedValue(obj, 'msg')).toBe('hello');
  });

  it('returns nested field value with dot notation', () => {
    const obj = { log: { message: 'hello' } };
    expect(getNestedValue(obj, 'log.message')).toBe('hello');
  });

  it('returns deeply nested field value', () => {
    const obj = { a: { b: { c: 'deep' } } };
    expect(getNestedValue(obj, 'a.b.c')).toBe('deep');
  });

  it('returns undefined for missing field', () => {
    const obj = { msg: 'hello' };
    expect(getNestedValue(obj, 'missing')).toBeUndefined();
  });

  it('returns undefined for missing nested field', () => {
    const obj = { log: { other: 'value' } };
    expect(getNestedValue(obj, 'log.message')).toBeUndefined();
  });

  it('returns undefined when intermediate path is null', () => {
    const obj = { log: null };
    expect(getNestedValue(obj, 'log.message')).toBeUndefined();
  });

  it('returns undefined when intermediate path is primitive', () => {
    const obj = { log: 'string' };
    expect(getNestedValue(obj, 'log.message')).toBeUndefined();
  });

  it('handles undefined input', () => {
    expect(getNestedValue(undefined, 'field')).toBeUndefined();
  });

  it('handles null input', () => {
    expect(getNestedValue(null, 'field')).toBeUndefined();
  });
});

describe('parseTimestamp', () => {
  it('parses ISO 8601 string', () => {
    const result = parseTimestamp('2025-01-15T10:30:00.000Z');
    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe('2025-01-15T10:30:00.000Z');
  });

  it('parses ISO 8601 string without milliseconds', () => {
    const result = parseTimestamp('2025-01-15T10:30:00Z');
    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe('2025-01-15T10:30:00.000Z');
  });

  it('parses Unix timestamp in seconds', () => {
    const result = parseTimestamp(1705315800);
    expect(result).toBeInstanceOf(Date);
    expect(result?.getTime()).toBe(1705315800000);
  });

  it('parses Unix timestamp in milliseconds', () => {
    const result = parseTimestamp(1705315800000);
    expect(result).toBeInstanceOf(Date);
    expect(result?.getTime()).toBe(1705315800000);
  });

  it('returns null for invalid string', () => {
    expect(parseTimestamp('not a date')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseTimestamp(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseTimestamp(undefined)).toBeNull();
  });

  it('returns null for non-date object', () => {
    expect(parseTimestamp({ foo: 'bar' })).toBeNull();
  });
});

describe('shouldProcessLevel', () => {
  it('returns true when no filter is configured', () => {
    expect(shouldProcessLevel('error', undefined)).toBe(true);
    expect(shouldProcessLevel('error', [])).toBe(true);
  });

  it('matches string level case-insensitively', () => {
    const filter = ['error', 'fatal'];
    expect(shouldProcessLevel('error', filter)).toBe(true);
    expect(shouldProcessLevel('ERROR', filter)).toBe(true);
    expect(shouldProcessLevel('Error', filter)).toBe(true);
    expect(shouldProcessLevel('fatal', filter)).toBe(true);
  });

  it('rejects non-matching string level', () => {
    const filter = ['error', 'fatal'];
    expect(shouldProcessLevel('info', filter)).toBe(false);
    expect(shouldProcessLevel('warn', filter)).toBe(false);
  });

  it('matches Bunyan numeric levels', () => {
    const filter = ['error', 'fatal'];
    expect(shouldProcessLevel(50, filter)).toBe(true); // error
    expect(shouldProcessLevel(60, filter)).toBe(true); // fatal
  });

  it('rejects non-matching Bunyan numeric levels', () => {
    const filter = ['error', 'fatal'];
    expect(shouldProcessLevel(30, filter)).toBe(false); // info
    expect(shouldProcessLevel(40, filter)).toBe(false); // warn
  });

  it('rejects unknown numeric levels', () => {
    const filter = ['error'];
    expect(shouldProcessLevel(99, filter)).toBe(false);
  });

  it('returns false when level is null/undefined but filter is configured', () => {
    const filter = ['error'];
    expect(shouldProcessLevel(null, filter)).toBe(false);
    expect(shouldProcessLevel(undefined, filter)).toBe(false);
  });
});

describe('parseNdjsonLine', () => {
  it('parses simple JSON with message field', () => {
    const line = '{"msg":"Hello world"}';
    const result = parseNdjsonLine(line, { messageField: 'msg' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe('Hello world');
      expect(result.data.timestamp).toBeInstanceOf(Date);
    }
  });

  it('extracts timestamp from configured field', () => {
    const line = '{"msg":"Hello","time":"2025-01-15T10:30:00.000Z"}';
    const result = parseNdjsonLine(line, {
      messageField: 'msg',
      timestampField: 'time',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe('Hello');
      expect(result.data.timestamp.toISOString()).toBe('2025-01-15T10:30:00.000Z');
    }
  });

  it('uses current time when timestamp field is missing', () => {
    const before = Date.now();
    const line = '{"msg":"Hello"}';
    const result = parseNdjsonLine(line, {
      messageField: 'msg',
      timestampField: 'time',
    });
    const after = Date.now();

    expect(result.success).toBe(true);
    if (result.success) {
      const ts = result.data.timestamp.getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    }
  });

  it('handles nested message field', () => {
    const line = '{"log":{"message":"Nested message"}}';
    const result = parseNdjsonLine(line, { messageField: 'log.message' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe('Nested message');
    }
  });

  it('handles nested timestamp field', () => {
    const line = '{"msg":"Hi","meta":{"timestamp":"2025-01-15T10:30:00.000Z"}}';
    const result = parseNdjsonLine(line, {
      messageField: 'msg',
      timestampField: 'meta.timestamp',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timestamp.toISOString()).toBe('2025-01-15T10:30:00.000Z');
    }
  });

  it('filters by level when configured', () => {
    const config = {
      messageField: 'msg',
      levelField: 'level',
      levelFilter: ['error', 'fatal'],
    };

    const errorLine = '{"msg":"Error occurred","level":"error"}';
    const infoLine = '{"msg":"Info message","level":"info"}';

    const errorResult = parseNdjsonLine(errorLine, config);
    const infoResult = parseNdjsonLine(infoLine, config);

    expect(errorResult.success).toBe(true);
    expect(infoResult.success).toBe(false);
    if (!infoResult.success) {
      expect(infoResult.reason).toBe('filtered');
    }
  });

  it('returns parse_error for invalid JSON', () => {
    const line = 'not valid json';
    const result = parseNdjsonLine(line, { messageField: 'msg' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('parse_error');
    }
  });

  it('returns parse_error for JSON primitive', () => {
    const line = '"just a string"';
    const result = parseNdjsonLine(line, { messageField: 'msg' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('parse_error');
    }
  });

  it('returns missing_message when message field is not found', () => {
    const line = '{"other":"value"}';
    const result = parseNdjsonLine(line, { messageField: 'msg' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('missing_message');
    }
  });

  it('converts non-string message values to string', () => {
    const line = '{"msg":12345}';
    const result = parseNdjsonLine(line, { messageField: 'msg' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe('12345');
    }
  });

  it('handles Pino log format', () => {
    const line = '{"level":50,"time":1705315800000,"msg":"Connection failed"}';
    const result = parseNdjsonLine(line, {
      messageField: 'msg',
      timestampField: 'time',
      levelField: 'level',
      levelFilter: ['error'],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe('Connection failed');
      expect(result.data.timestamp.getTime()).toBe(1705315800000);
    }
  });

  it('handles Winston log format', () => {
    const line = '{"level":"error","message":"Something went wrong","timestamp":"2025-01-15T10:30:00.000Z"}';
    const result = parseNdjsonLine(line, {
      messageField: 'message',
      timestampField: 'timestamp',
      levelField: 'level',
      levelFilter: ['error'],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe('Something went wrong');
      expect(result.data.timestamp.toISOString()).toBe('2025-01-15T10:30:00.000Z');
    }
  });

  it('handles ECS log format with nested level', () => {
    const line = '{"message":"Request failed","@timestamp":"2025-01-15T10:30:00.000Z","log":{"level":"error"}}';
    const result = parseNdjsonLine(line, {
      messageField: 'message',
      timestampField: '@timestamp',
      levelField: 'log.level',
      levelFilter: ['error'],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe('Request failed');
      expect(result.data.timestamp.toISOString()).toBe('2025-01-15T10:30:00.000Z');
    }
  });
});
