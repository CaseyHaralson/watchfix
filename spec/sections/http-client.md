# HTTP Client for Health Checks

## Requirements

Uses Node.js built-in fetch API (Node 18+).

## Behavior

- HTTP GET requests only
- Expect 2xx response (200-299) for success
- Follow redirects up to 5 hops
- If 5th response is still a redirect, treat as failure: "Too many redirects"
- Send `User-Agent: selfheal/1.0` header
- No request body
- Timeout support (default: 10s)

## Interface

```typescript
interface HealthCheckResult {
  success: boolean;
  status?: number;
  error?: string;
}

async function checkHealth(
  url: string,
  timeout: number
): Promise<HealthCheckResult> {
  // Implementation
}
```

## Expected Results

| Scenario | Result |
|----------|--------|
| 2xx response | `{ success: true, status: 200 }` |
| Non-2xx response | `{ success: false, status: 404 }` |
| More than 5 redirects | `{ success: false, error: "Too many redirects" }` |
| Network error | `{ success: false, error: "ECONNREFUSED" }` |
| Timeout | `{ success: false, error: "Request timed out" }` |
