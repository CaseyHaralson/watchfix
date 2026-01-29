const BUILTIN_MATCH_PATTERNS: ReadonlyArray<RegExp> = [
  // JavaScript
  /Error:/,
  /TypeError:/,
  /ReferenceError:/,
  /SyntaxError:/,
  /RangeError:/,
  /URIError:/,
  /EvalError:/,
  // Node.js
  /UnhandledPromiseRejection/,
  /\bECONNREFUSED\b/,
  /\bENOTFOUND\b/,
  /\bETIMEDOUT\b/,
  /\bEADDRINUSE\b/,
  /\bEACCES\b/,
  /\bEPERM\b/,
  // Python
  /Traceback \(most recent call last\)/,
  /Exception:/,
  /AssertionError:/,
  // Go
  /panic:/,
  /fatal error:/,
  /runtime error:/,
  // Docker
  /container is not running/i,
  /unhealthy/i,
  /OOMKilled/,
  /no such container/i,
  /connection refused/i,
  // Database
  /SQLSTATE\[/,
  /deadlock detected/i,
  /duplicate key/i,
  /constraint violation/i,
  // Generic
  /\b(FATAL|CRITICAL|EMERGENCY)(?:[:\s]|$)/i,
];

const BUILTIN_IGNORE_PATTERNS: ReadonlyArray<RegExp> = [
  /^(DEBUG|TRACE|VERBOSE|INFO)(?:[:\s]|$)/,
  /\b(successfully|healthy|passed|completed|OK)\b/i,
];

const REGEX_PREFIX = 'regex:';

const matchesRegex = (line: string, source: string): boolean => {
  try {
    const pattern = new RegExp(source);
    return pattern.test(line);
  } catch {
    return false;
  }
};

const matchesCustomPatterns = (
  line: string,
  patterns: string[] | undefined
): boolean => {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  const lowerLine = line.toLowerCase();
  return patterns.some((pattern) => {
    if (pattern.startsWith(REGEX_PREFIX)) {
      return matchesRegex(line, pattern.slice(REGEX_PREFIX.length));
    }

    return lowerLine.includes(pattern.toLowerCase());
  });
};

const matchesBuiltinPatterns = (line: string, patterns: ReadonlyArray<RegExp>) =>
  patterns.some((pattern) => pattern.test(line));

const matchesErrorPattern = (
  line: string,
  customMatch?: string[],
  customIgnore?: string[]
): boolean => {
  if (
    matchesBuiltinPatterns(line, BUILTIN_IGNORE_PATTERNS) ||
    matchesCustomPatterns(line, customIgnore)
  ) {
    return false;
  }

  return (
    matchesBuiltinPatterns(line, BUILTIN_MATCH_PATTERNS) ||
    matchesCustomPatterns(line, customMatch)
  );
};

const extractErrorType = (message: string): string => {
  const patterns: Array<[RegExp, number]> = [
    [/^(\w+Error):/, 1],
    [/^(\w+Exception):/, 1],
    [/(E[A-Z]{2,})(?:[\s:,]|$)/, 1],
    [/^(panic):/, 1],
    [/^(FATAL|CRITICAL):?/i, 1],
    [/SQLSTATE\[(\w+)\]/, 1],
  ];

  for (const [pattern, group] of patterns) {
    const match = message.match(pattern);
    if (match) {
      return match[group];
    }
  }

  return 'Error';
};

export {
  BUILTIN_IGNORE_PATTERNS,
  BUILTIN_MATCH_PATTERNS,
  extractErrorType,
  matchesErrorPattern,
};
