# Error Detection Patterns

## Built-in Match Patterns (trigger detection)

Always active, cannot be disabled.

| Category | Patterns |
|----------|----------|
| JavaScript | `Error:`, `TypeError:`, `ReferenceError:`, `SyntaxError:`, `RangeError:`, `URIError:`, `EvalError:` |
| Node.js | `UnhandledPromiseRejection`, `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `EADDRINUSE`, `EACCES`, `EPERM` |
| Python | `Traceback (most recent call last)`, `Exception:`, `Error:`, `AssertionError:` |
| Go | `panic:`, `fatal error:`, `runtime error:` |
| Docker | `container is not running`, `unhealthy`, `OOMKilled`, `no such container`, `connection refused` |
| Database | `SQLSTATE[`, `deadlock detected`, `duplicate key`, `constraint violation` |
| Generic | `FATAL`, `CRITICAL`, `EMERGENCY` (case-insensitive, must be followed by `:` or whitespace) |

## Built-in Ignore Patterns (suppress detection)

| Category | Patterns |
|----------|----------|
| Log levels | `DEBUG`, `TRACE`, `VERBOSE`, `INFO` (when at line start, followed by `:` or whitespace) |
| Success indicators | `successfully`, `healthy`, `passed`, `completed`, `OK` |

**Priority:** Ignore patterns take precedence over match patterns.

## Custom Pattern Format

From `watchfix.yaml`:

```yaml
patterns:
  match:
    - "circuit breaker open"      # Plain string (case-insensitive substring match)
    - "regex:timeout after \\d+s" # Regex (prefix with regex:)
  ignore:
    - "retry attempt"
    - "regex:connection reset.*transient"
```

## Error Type Extraction

Extract error type from message for display and deduplication:

```typescript
function extractErrorType(message: string): string {
  const patterns: Array<[RegExp, number]> = [
    [/^(\w+Error):/, 1],              // TypeError:, ReferenceError:
    [/^(\w+Exception):/, 1],          // NullPointerException:
    [/(E[A-Z]{2,})(?:[\s:,]|$)/, 1],  // ECONNREFUSED, ENOTFOUND
    [/^(panic):/, 1],                 // Go panic
    [/^(FATAL|CRITICAL):?/i, 1],      // Generic fatal
    [/SQLSTATE\[(\w+)\]/, 1],         // Database errors
  ];

  for (const [pattern, group] of patterns) {
    const match = message.match(pattern);
    if (match) return match[group];
  }
  return 'Error'; // Default fallback
}
```

## Continuation Patterns (multi-line stack traces)

Lines attached to previous error:

- Lines starting with `at ` (JS stack frames)
- Lines starting with whitespace followed by `at ` or `in `
- Lines matching `^\s+File "` (Python stack frames)
- Lines matching `^\s+\d+:\d+` (Go stack frames with line:col)
- Lines matching `^\s+\.\.\.` (truncation indicators)

## Buffer Flush Triggers

- A new error line is detected
- A non-continuation, non-error line is detected
- 100ms passes with no new input

## Line Length Limit

Lines exceeding 64KB are truncated with `... [truncated]` suffix.
