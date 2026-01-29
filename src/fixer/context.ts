import path from 'node:path';

import type { Config } from '../config/schema.js';
import type { ErrorRecord } from '../db/queries.js';

type GeneratedContext = {
  path: string;
  content: string;
};

const CONTEXT_DIR = path.posix.join('.watchfix', 'context');
const STACK_TRACE_MAX_BYTES = 32 * 1024;
const STACK_TRACE_SLICE_BYTES = 16 * 1024;
const STACK_TRACE_TRUNCATION_MARKER = '[...truncated...]';

const formatDate = (date = new Date()): string => date.toISOString().slice(0, 10);

const sliceUtf8ByBytes = (
  value: string,
  bytes: number,
  position: 'start' | 'end'
): string => {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= bytes) {
    return value;
  }
  return position === 'start'
    ? buffer.subarray(0, bytes).toString('utf8')
    : buffer.subarray(buffer.length - bytes).toString('utf8');
};

const truncateStackTrace = (stackTrace: string): string => {
  if (Buffer.byteLength(stackTrace, 'utf8') <= STACK_TRACE_MAX_BYTES) {
    return stackTrace;
  }
  const head = sliceUtf8ByBytes(stackTrace, STACK_TRACE_SLICE_BYTES, 'start');
  const tail = sliceUtf8ByBytes(stackTrace, STACK_TRACE_SLICE_BYTES, 'end');
  return `${head}\n${STACK_TRACE_TRUNCATION_MARKER}\n${tail}`;
};

const sanitizeUtf8 = (value: string): string => {
  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[i] + value[i + 1];
        i += 1;
        continue;
      }
      result += '\uFFFD';
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      result += '\uFFFD';
      continue;
    }
    result += value[i];
  }
  return result;
};

const splitRawLog = (
  error: ErrorRecord
): { before: string[]; after: string[] } => {
  if (!error.rawLog) {
    return { before: [], after: [] };
  }
  const lines = error.rawLog.split('\n');
  const errorIndex = lines.indexOf(error.message);
  if (errorIndex < 0) {
    return { before: lines, after: [] };
  }

  const afterStart = errorIndex + 1;
  const stackLines = error.stackTrace ? error.stackTrace.split('\n') : [];
  let afterLines = lines.slice(afterStart);
  if (stackLines.length > 0) {
    let matchCount = 0;
    while (
      matchCount < stackLines.length &&
      afterLines[matchCount] === stackLines[matchCount]
    ) {
      matchCount += 1;
    }
    if (matchCount > 0) {
      afterLines = afterLines.slice(matchCount);
    }
  }
  return {
    before: lines.slice(0, errorIndex),
    after: afterLines,
  };
};

const buildContextBlock = (
  beforeLines: string[],
  errorLines: string[],
  afterLines: string[],
  truncatedLineCount: number
): string => {
  const lines: string[] = [];
  if (truncatedLineCount > 0) {
    lines.push(
      `[...${truncatedLineCount} lines truncated due to size limit...]`
    );
  }
  lines.push(...beforeLines);
  lines.push('---ERROR---');
  lines.push(...errorLines);
  lines.push('---END ERROR---');
  lines.push(...afterLines);
  return lines.join('\n');
};

const truncateStackTraceToBytes = (
  stackTrace: string,
  maxBytes: number
): string => {
  if (maxBytes <= 0) {
    return '';
  }
  if (Buffer.byteLength(stackTrace, 'utf8') <= maxBytes) {
    return stackTrace;
  }
  const markerBytes = Buffer.byteLength(STACK_TRACE_TRUNCATION_MARKER, 'utf8');
  if (maxBytes <= markerBytes) {
    return sliceUtf8ByBytes(stackTrace, maxBytes, 'start');
  }
  const headBytes = Math.max(0, maxBytes - markerBytes - 1);
  const head = headBytes > 0 ? sliceUtf8ByBytes(stackTrace, headBytes, 'start') : '';
  return head ? `${head}\n${STACK_TRACE_TRUNCATION_MARKER}` : STACK_TRACE_TRUNCATION_MARKER;
};

const buildAnalyzeContent = (options: {
  projectName: string;
  projectRoot: string;
  error: ErrorRecord;
  attempt: number;
  date: string;
  stackTrace: string;
  contextBlock: string;
}): string => {
  const { projectName, projectRoot, error, attempt, date, stackTrace } = options;
  const analysisPath = path.posix.join(
    CONTEXT_DIR,
    `${date}-error-${error.id}-attempt-${attempt}-analysis.yaml`
  );

  return `# WatchFix Task

## Mode
analyze

## Project
- Name: ${projectName}
- Root: ${projectRoot}

## Error Details
- ID: ${error.id}
- Source: ${error.source}
- Type: ${error.errorType}
- Detected: ${error.timestamp}
- Fix Attempts: ${error.fixAttempts}

### Message
${error.message}

### Stack Trace
${stackTrace}

### Context (surrounding log lines)
${options.contextBlock}

## Instructions

1. Investigate the project structure to understand the codebase
2. Identify the root cause of this error
3. Determine what files need to be modified
4. Assess your confidence in the fix

Write your analysis to: \`${analysisPath}\`

Use this exact YAML format:
\`\`\`yaml
summary: One sentence summary of the problem
root_cause: |
  Detailed explanation of root cause
  Can be multiple lines
suggested_fix: |
  What changes to make
  Step by step if needed
files_to_modify:
  - path/to/file1
  - path/to/file2
confidence: high | medium | low
\`\`\`

## Constraints
- Do NOT modify any files during analysis
- If you cannot determine the cause, set confidence to "low"
- Be specific about file paths relative to project root
- WARNING: If a fix fails and is retried, any file modifications from previous attempts will persist
`;
};

const buildFixContent = (options: {
  projectName: string;
  projectRoot: string;
  error: ErrorRecord;
  attempt: number;
  date: string;
  stackTrace: string;
  analysis: string;
}): string => {
  const { projectName, projectRoot, error, attempt, date, stackTrace, analysis } =
    options;
  const resultPath = path.posix.join(
    CONTEXT_DIR,
    `${date}-error-${error.id}-attempt-${attempt}-result.yaml`
  );

  return `# WatchFix Task

## Mode
fix

## Project
- Name: ${projectName}
- Root: ${projectRoot}

## Error Details
- ID: ${error.id}
- Source: ${error.source}
- Type: ${error.errorType}
- Detected: ${error.timestamp}
- Fix Attempts: ${error.fixAttempts}

### Message
${error.message}

### Stack Trace
${stackTrace}

## Previous Analysis
${analysis}

## Instructions

1. Read the previous analysis above
2. Implement the suggested fix
3. Follow existing code style and conventions
4. Make minimal, targeted changes

Write your results to: \`${resultPath}\`

Use this exact YAML format:
\`\`\`yaml
success: true | false
summary: One sentence describing what was done
files_changed:
  - path: relative/path/to/file
    change: Description of change made
notes: |
  Optional additional notes
  Can be multiple lines
\`\`\`

## Constraints
- Make the smallest change that resolves the issue
- Do NOT change unrelated code
- If the fix cannot be applied, set success to false and explain in notes
- WARNING: If this fix fails verification, the modified files will remain changed for the next retry attempt
`;
};

const resolveProjectRoot = (config: Config): string =>
  path.resolve(config.project.root);

const ensureSizeLimit = (options: {
  maxBytes: number;
  beforeLines: string[];
  afterLines: string[];
  stackTrace: string;
  render: (before: string[], after: string[], stack: string, truncated: number) => string;
}): {
  content: string;
  truncatedLines: number;
  beforeLines: string[];
  afterLines: string[];
  stackTrace: string;
} => {
  let truncatedLines = 0;
  let beforeLines = [...options.beforeLines];
  let afterLines = [...options.afterLines];
  let stackTrace = options.stackTrace;
  let content = options.render(beforeLines, afterLines, stackTrace, truncatedLines);

  // Phase 1: Remove beforeLines (oldest context first)
  while (
    Buffer.byteLength(content, 'utf8') > options.maxBytes &&
    beforeLines.length > 0
  ) {
    beforeLines = beforeLines.slice(1);
    truncatedLines += 1;
    content = options.render(beforeLines, afterLines, stackTrace, truncatedLines);
  }

  // Phase 2: Remove afterLines (if still over limit)
  while (
    Buffer.byteLength(content, 'utf8') > options.maxBytes &&
    afterLines.length > 0
  ) {
    afterLines = afterLines.slice(0, -1);
    content = options.render(beforeLines, afterLines, stackTrace, truncatedLines);
  }

  // Phase 3: Further truncate stack trace using binary search (if still over)
  if (Buffer.byteLength(content, 'utf8') > options.maxBytes && stackTrace) {
    let low = 0;
    let high = Buffer.byteLength(stackTrace, 'utf8');
    let best = '';

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = truncateStackTraceToBytes(stackTrace, mid);
      const candidateContent = options.render(beforeLines, afterLines, candidate, truncatedLines);
      if (Buffer.byteLength(candidateContent, 'utf8') <= options.maxBytes) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    stackTrace = best;
    content = options.render(beforeLines, afterLines, stackTrace, truncatedLines);
  }

  return { content, truncatedLines, beforeLines, afterLines, stackTrace };
};

export const generateAnalyzeContext = (
  error: ErrorRecord,
  config: Config,
  attempt: number
): GeneratedContext => {
  const date = formatDate();
  const contextPath = path.posix.join(
    CONTEXT_DIR,
    `${date}-error-${error.id}-attempt-${attempt}-analyze.md`
  );
  const maxBytes = config.cleanup.context_max_size_kb * 1024;
  const { before, after } = splitRawLog(error);

  const buildContent = (
    stackTraceValue: string,
    beforeLines: string[],
    afterLines: string[],
    truncated: number
  ): string => {
    const errorLines = [error.message];
    if (stackTraceValue) {
      errorLines.push(...stackTraceValue.split('\n'));
    }
    return buildAnalyzeContent({
      projectName: config.project.name,
      projectRoot: resolveProjectRoot(config),
      error,
      attempt,
      date,
      stackTrace: stackTraceValue,
      contextBlock: buildContextBlock(
        beforeLines,
        errorLines,
        afterLines,
        truncated
      ),
    });
  };

  const stackTrace = truncateStackTrace(error.stackTrace ?? '');
  const render = (
    beforeLines: string[],
    afterLines: string[],
    stackTraceValue: string,
    truncated: number
  ) => buildContent(stackTraceValue, beforeLines, afterLines, truncated);

  const { content } = ensureSizeLimit({
    maxBytes,
    beforeLines: before,
    afterLines: after,
    stackTrace,
    render,
  });

  return {
    path: contextPath,
    content: sanitizeUtf8(content),
  };
};

const ensureFixSizeLimit = (options: {
  maxBytes: number;
  analysis: string;
  stackTrace: string;
  render: (analysis: string, stack: string) => string;
}): {
  content: string;
  analysis: string;
  stackTrace: string;
} => {
  let analysis = options.analysis;
  let stackTrace = options.stackTrace;
  let content = options.render(analysis, stackTrace);

  // Phase 1: Truncate analysis content (from end, preserving summary)
  if (Buffer.byteLength(content, 'utf8') > options.maxBytes && analysis) {
    let low = 0;
    let high = Buffer.byteLength(analysis, 'utf8');
    let best = '';

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = sliceUtf8ByBytes(analysis, mid, 'start');
      const candidateContent = options.render(candidate, stackTrace);
      if (Buffer.byteLength(candidateContent, 'utf8') <= options.maxBytes) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    analysis = best;
    content = options.render(analysis, stackTrace);
  }

  // Phase 2: Further truncate stack trace using binary search (if still over)
  if (Buffer.byteLength(content, 'utf8') > options.maxBytes && stackTrace) {
    let low = 0;
    let high = Buffer.byteLength(stackTrace, 'utf8');
    let best = '';

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = truncateStackTraceToBytes(stackTrace, mid);
      const candidateContent = options.render(analysis, candidate);
      if (Buffer.byteLength(candidateContent, 'utf8') <= options.maxBytes) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    stackTrace = best;
    content = options.render(analysis, stackTrace);
  }

  return { content, analysis, stackTrace };
};

export const generateFixContext = (
  error: ErrorRecord,
  analysis: string,
  config: Config,
  attempt: number
): GeneratedContext => {
  const date = formatDate();
  const contextPath = path.posix.join(
    CONTEXT_DIR,
    `${date}-error-${error.id}-attempt-${attempt}-fix.md`
  );
  const maxBytes = config.cleanup.context_max_size_kb * 1024;
  const stackTrace = truncateStackTrace(error.stackTrace ?? '');

  const render = (analysisValue: string, stackTraceValue: string): string =>
    buildFixContent({
      projectName: config.project.name,
      projectRoot: resolveProjectRoot(config),
      error,
      attempt,
      date,
      stackTrace: stackTraceValue,
      analysis: analysisValue,
    });

  const { content } = ensureFixSizeLimit({
    maxBytes,
    analysis,
    stackTrace,
    render,
  });

  return {
    path: contextPath,
    content: sanitizeUtf8(content),
  };
};

export type { GeneratedContext };
