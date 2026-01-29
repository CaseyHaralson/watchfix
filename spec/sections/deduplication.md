# Error Deduplication

## Hash Computation

Errors are deduplicated by hash: `sha256(source + error_type + normalized_message)`

## Message Normalization

Before hashing, the message is normalized:

1. Trim whitespace
2. Remove timestamps (ISO8601 patterns)
3. Remove UUIDs
4. Remove memory addresses (0x...)
5. Collapse multiple spaces to single space
6. **Case is preserved** (not lowercased) to distinguish between different error types

```typescript
function normalizeMessage(message: string): string {
  return message
    // Remove ISO8601 timestamps
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?/g, '')
    // Remove UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
    // Remove memory addresses
    .replace(/0x[0-9a-f]+/gi, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}
```

## Deduplication Rules

| Existing Status | New Error Behavior |
|-----------------|-------------------|
| `pending`, `analyzing`, `suggested`, `fixing` | Drop (already being handled) |
| `fixed`, `failed`, `ignored` | Create new entry (error recurred) |

## Recurring Error Handling

When a duplicate is detected for an error in `fixed`, `failed`, or `ignored` status, a new error entry is created with:

- `created_at` set to the **new** detection time
- `fix_attempts` reset to 0
- `suggestion` and `fix_result` cleared (NULL)
- `status` set to `pending`
