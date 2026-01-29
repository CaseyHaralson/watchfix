export interface HealthCheckResult {
  success: boolean;
  status?: number;
  error?: string;
}

const MAX_REDIRECTS = 5;
const USER_AGENT = 'watchfix/1.0';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isRedirect(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function resolveErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const err = error as {
      code?: string;
      message?: string;
      cause?: { code?: string; message?: string };
    };
    return (
      err.cause?.code ??
      err.cause?.message ??
      err.code ??
      err.message ??
      'Network error'
    );
  }
  return 'Network error';
}

export async function checkHealth(
  url: string,
  timeout = 10_000,
): Promise<HealthCheckResult> {
  let currentUrl = url;
  let redirects = 0;

  while (redirects <= MAX_REDIRECTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(currentUrl, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'manual',
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (isRedirect(response.status)) {
        if (redirects >= MAX_REDIRECTS) {
          return { success: false, error: 'Too many redirects' };
        }
        const location = response.headers.get('location');
        if (!location) {
          return { success: false, status: response.status };
        }
        redirects += 1;
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (response.status >= 200 && response.status <= 299) {
        return { success: true, status: response.status };
      }
      return { success: false, status: response.status };
    } catch (error) {
      clearTimeout(timer);
      if (isAbortError(error)) {
        return { success: false, error: 'Request timed out' };
      }
      return { success: false, error: resolveErrorMessage(error) };
    }
  }

  return { success: false, error: 'Too many redirects' };
}
