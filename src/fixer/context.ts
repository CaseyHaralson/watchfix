import path from 'node:path';

import type { Config } from '../config/schema.js';
import type { ErrorRecord } from '../db/queries.js';

type RetryContext = {
  previousAttempt: {
    analysis?: { summary: string; suggested_fix: string; files_to_modify: string[] };
    fix?: { success: boolean; summary: string; files_changed?: Array<{ path: string; change: string }> };
    verification_failure?: { type: string; command?: string; message?: string; stderr?: string };
  };
};

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

const buildRetrySection = (retryContext: RetryContext, attempt: number): string => {
  const { previousAttempt } = retryContext;
  const lines: string[] = [
    `## IMPORTANT: This is a RETRY (Attempt ${attempt + 1})`,
    '',
    'The previous fix attempt was applied but **verification failed**.',
    '',
    '### What was tried:',
  ];

  if (previousAttempt.analysis) {
    lines.push(`- Analysis: ${previousAttempt.analysis.summary}`);
    if (previousAttempt.analysis.files_to_modify.length > 0) {
      lines.push(`- Files modified: ${previousAttempt.analysis.files_to_modify.join(', ')}`);
    }
  }
  if (previousAttempt.fix) {
    lines.push(`- Fix applied: ${previousAttempt.fix.summary}`);
  }

  lines.push('');
  lines.push('### Why it failed:');

  if (previousAttempt.verification_failure) {
    const vf = previousAttempt.verification_failure;
    lines.push(`**Verification command failed**: ${vf.command || 'unknown'}`);
    lines.push(`**Message**: ${vf.message || 'unknown'}`);
    if (vf.stderr) {
      lines.push('**Test output**:');
      lines.push('```');
      lines.push(vf.stderr.slice(0, 2000));
      lines.push('```');
    }
  } else {
    lines.push('Verification failed (details not available)');
  }

  lines.push('');
  lines.push('### Instructions for retry:');
  lines.push('1. The code has ALREADY been modified by the previous attempt');
  lines.push('2. Do NOT report already_fixed unless the verification test is actually passing');
  lines.push('3. Focus on the verification failure output - it shows what\'s still broken');
  lines.push('4. The original error message may not appear in code anymore, but the test is still failing');
  lines.push('');

  return lines.join('\n');
};

const buildAnalyzeContent = (options: {
  projectName: string;
  projectRoot: string;
  error: ErrorRecord;
  attempt: number;
  date: string;
  stackTrace: string;
  contextBlock: string;
  retryContext?: RetryContext;
}): string => {
  const { projectName, projectRoot, error, attempt, date, stackTrace } = options;
  const analysisPath = path.posix.join(
    CONTEXT_DIR,
    `${date}-error-${error.id}-attempt-${attempt + 1}-analysis.yaml`
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
- Fix Attempts: ${error.fixAttempts + 1}

### Message
${error.message}

### Stack Trace
${stackTrace}

### Context (surrounding log lines)
${options.contextBlock}
${options.retryContext ? `
${buildRetrySection(options.retryContext, options.attempt)}` : ''}
## Instructions

1. **Check if this issue still exists in the code**
   - Look at the file(s) mentioned in the stack trace
   - If the code has been fixed, report already_fixed: true

2. **Trace the root cause** (not just the symptom):
   - Ask WHY the error occurs, not just WHERE
   - Common root causes to check:
     - Type mismatches in comparisons (e.g., comparing incompatible types)
     - Failed lookups due to incorrect comparison logic
     - Missing type conversions on input values
   - Follow the data flow from source to error location
   - The fix should address the underlying cause, not just guard against the symptom

3. **Determine the minimal fix location**:
   - Fix at the point where the bug originates, not where it manifests
   - For type issues: convert types at the source
   - For unhandled errors: add error handling at the CALL SITE only
   - Do NOT modify functions that throw errors - handle errors where they are called

## Anti-patterns to Avoid
- Adding null/undefined checks that mask the real bug (e.g., the check passes but the lookup logic is still wrong)
- Modifying error-throwing functions instead of handling at call sites
- Adding environment variables, feature flags, or extra parameters
- Refactoring or improving code beyond the specific fix

Write your analysis to: \`${analysisPath}\`

Use this exact YAML format:
\`\`\`yaml
already_fixed: true | false
summary: One sentence summary of the problem (or that it was already fixed)
# The following fields are only required if already_fixed is false:
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
- Set already_fixed to true if the issue no longer exists in the code (e.g., fixed by a previous error fix)
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
    `${date}-error-${error.id}-attempt-${attempt + 1}-result.yaml`
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
- Fix Attempts: ${error.fixAttempts + 1}

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
- Make the SMALLEST change that fixes the ROOT CAUSE
- Fix the bug where it originates, not where symptoms appear
- Do NOT add defensive checks that mask the real bug
- Do NOT modify functions that throw errors - add handling at call sites
- Do NOT add environment variables, feature flags, or new parameters
- Do NOT refactor, improve, or clean up code beyond the fix
- If touching more than 1-2 files or 10 lines, reconsider your approach
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
  attempt: number,
  retryContext?: RetryContext
): GeneratedContext => {
  const date = formatDate();
  const contextPath = path.posix.join(
    CONTEXT_DIR,
    `${date}-error-${error.id}-attempt-${attempt + 1}-analyze.md`
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
      retryContext,
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
    `${date}-error-${error.id}-attempt-${attempt + 1}-fix.md`
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
