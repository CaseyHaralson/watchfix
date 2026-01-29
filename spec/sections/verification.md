# Verification

After a fix is applied:

## Steps

1. **Wait**: Sleep for `wait_after_fix` duration (default: 5s)

2. **Test commands**: Run each command in `test_commands` sequentially
   - Commands execute in a shell (`shell: true` in spawn options)
   - On Windows, uses `cmd.exe`; on Unix, uses `/bin/sh`
   - Working directory is the project root
   - Stop on first non-zero exit code
   - Capture stdout/stderr for logging
   - Timeout: `test_command_timeout` per command (default: 5m)

3. **Health checks**: HTTP GET each URL in `health_checks`
   - Expect 2xx response (200-299)
   - Follows redirects (up to 5 hops)
   - If 5th response is still a redirect, treat as failure: "Too many redirects"
   - Sends `User-Agent: selfheal/1.0` header
   - Does not send request body
   - Timeout: `health_check_timeout` (default: 10s) per check
   - Stop on first failure

## Outcomes

| Result | Action |
|--------|--------|
| All pass | Set status to `fixed`, log success |
| Any fail | Increment `fix_attempts`, set status based on attempts |

## Empty Verification Config

- If `test_commands` is empty or undefined: skip test command phase
- If `health_checks` is empty or undefined: skip health check phase
- If both are empty: verification automatically passes

## Post-Verification Status Logic

```typescript
function determinePostVerificationStatus(
  verificationPassed: boolean,
  currentAttempts: number,
  maxAttempts: number
): { status: ErrorStatus; shouldRetry: boolean } {
  if (verificationPassed) {
    return { status: 'fixed', shouldRetry: false };
  }

  const newAttempts = currentAttempts + 1;

  if (newAttempts >= maxAttempts) {
    return { status: 'failed', shouldRetry: false };
  }

  return { status: 'pending', shouldRetry: true };
}
```

## Verification Failure Handling

When verification fails:
1. Log which step failed and why (command output or HTTP status)
2. Increment `fix_attempts`
3. If under limit: set status to `pending`, add to back of fix queue (autonomous mode)
4. If at limit: set status to `failed`, log final failure

## No Automatic Rollback

When verification fails, modified files remain in place. The error returns to `pending` status for retry, which will re-analyze the (now-modified) codebase. Users who want rollback should use version control.
