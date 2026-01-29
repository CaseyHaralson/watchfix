# Error Status Values

## Status Type

```typescript
type ErrorStatus = 'pending' | 'analyzing' | 'suggested' | 'fixing' | 'fixed' | 'failed' | 'ignored';
```

## Status Definitions

| Status | Description |
|--------|-------------|
| `pending` | Detected, awaiting analysis |
| `analyzing` | Agent is currently analyzing |
| `suggested` | Analysis complete, awaiting fix |
| `fixing` | Agent is currently applying fix |
| `fixed` | Fix verified successfully |
| `failed` | Max attempts exceeded |
| `ignored` | User chose to ignore |

## Status Flow

```
Error Detected
     |
     v
  pending ----------------------------------------.
     |                                            |
     v                                            |
  analyzing --- failure ------------------------->|
     |                                            |
     v                                            |
  suggested -----------------------------------.  |
     |                                         |  |
     | <-- [human approval in manual mode]     |  |
     v                                         |  |
  fixing ---- failure ------------------------>|  |
     |                                         |  |
     v                                         |  |
  [verification]                               |  |
     |                                         |  |
  +--+--+                                      |  |
  |     |                                      |  |
pass   fail                                    |  |
  |     |                                      |  |
  v     +---- (attempts < max) --------------->+  |
fixed         |                                   |
              |                                   |
              +---- (attempts >= max) -------> failed

User action: -------------------------------------> ignored
```
