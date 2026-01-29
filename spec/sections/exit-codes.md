# Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error (config invalid, agent failed, etc.) |
| 2 | Watcher state conflict (already running / not running) |
| 3 | Target not actionable (error not found, wrong status, locked) |
| 4 | Database schema mismatch (requires migration) |
| 130 | Interrupted by user (SIGINT) |

## TypeScript Constants

```typescript
export const EXIT_CODES = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  WATCHER_CONFLICT: 2,
  NOT_ACTIONABLE: 3,
  SCHEMA_MISMATCH: 4,
  INTERRUPTED: 130,
} as const;
```
