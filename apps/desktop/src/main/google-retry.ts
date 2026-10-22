/**
 * Retrying request helper shared by the Google Sheets and BigQuery exports.
 *
 * Retries 429, 408, 5xx and network errors with truncated exponential
 * backoff (1, 2, 4 ... 64 s, each plus 0-1 s of jitter); a longer
 * `Retry-After` replaces the computed delay. The total wait per request is
 * capped, then the error names the operation, the last status and the wait.
 * A 401 refreshes the token once; a 401 that stays (or a refresh
 * that Google answers with an error) is a {@link GoogleAuthError}: the grant is revoked or the key deleted, so
 * nothing is retried and the message says to reconnect the account (or check
 * the service-account key). A refresh that never got an answer is a network error and is retried. Time
 * spent inside the requests counts toward the wait cap. Other 4xx answers are returned as they
 * are for the caller to read.
 *
 * Everything that touches the outside world comes in through `GoogleDeps`,
 * so tests run with a fake fetch and a fake clock. Like the Metrica client,
 * it never puts the text of a failed request's error into a log or result:
 * undici quotes the URL and the token in it.
 */
export interface GoogleDeps {
  fetch: typeof fetch;
  /** Access token; `true` asks for a fresh one after a 401. */
  getToken: (refresh?: boolean) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Jitter source, 0 <= n < 1. */
  random: () => number;
  log: (level: 'info' | 'warn', message: string) => void;
  /** What to do when the sign-in is rejected; default: reconnect the Google account. */
  authFix?: string;
}

export interface GoogleRequest {
  /** Names the request in errors and logs, e.g. `Sheets write batch 2`. */
  op: string;
  method: string;
  url: string;
  body?: unknown;
  timeoutMs?: number;
  /** False for a request that must not be repeated once it may have landed. */
  retryNetwork?: boolean;
}

export interface GoogleResponse {
  status: number;
  ok: boolean;
  json: unknown;
}

/** The Google sign-in no longer works: reconnecting the account is the only fix. */
export class GoogleAuthError extends Error {
  constructor(
    op: string,
    fix = 'Reconnect the Google account in Settings → Integrations and try again.',
    /** Why no token could be had (the token request's own message); replaces the «HTTP 401» wording. */
    reason?: string,
  ) {
    super(
      reason
        ? `${op} failed: no Google sign-in token (${reason}) ${fix}`
        : `${op} failed: Google rejected the sign-in (HTTP 401). ${fix}`,
    );
    this.name = 'GoogleAuthError';
  }
}

/** Google's per-minute or daily quota is used up; the caller should stop, not go on to the next item. */
export class GoogleQuotaError extends Error {
  constructor(op: string, detail: string) {
    super(`${op} failed: ${detail}`);
    this.name = 'GoogleQuotaError';
  }
}

/** The account may not read this resource (HTTP 403 PERMISSION_DENIED): every further call would fail the same way. */
export class GooglePermissionError extends Error {
  constructor(op: string, message: string) {
    super(`${op} failed: ${message}`);
    this.name = 'GooglePermissionError';
  }
}

/**
 * Reads a non-retried Google answer: a typed quota error for HTTP 429, a 403 with reason
 * `rateLimitExceeded` / `quotaExceeded`, or status `RESOURCE_EXHAUSTED`; a typed permission error
 * for 403 `PERMISSION_DENIED`. Returns normally for anything else.
 */
export function throwIfQuotaOrPermission(op: string, status: number, json: unknown): void {
  const err = ((json as { error?: unknown } | null)?.error ?? {}) as {
    status?: unknown;
    message?: unknown;
    errors?: { reason?: unknown }[];
  };
  const reasons = Array.isArray(err.errors) ? err.errors.map((e) => e?.reason) : [];
  const message = typeof err.message === 'string' && err.message ? err.message : `HTTP ${status}`;
  if (
    status === 429 ||
    err.status === 'RESOURCE_EXHAUSTED' ||
    (status === 403 && reasons.some((r) => r === 'rateLimitExceeded' || r === 'quotaExceeded'))
  ) {
    throw new GoogleQuotaError(op, message);
  }
  if (status === 403 && err.status === 'PERMISSION_DENIED') {
    throw new GooglePermissionError(op, message);
  }
}

/** A refresh that failed before any answer (timeout, DNS, reset), as opposed to Google saying no. */
function isNetworkFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true; // undici: "fetch failed"
  const name = (err as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

const MAX_TOTAL_WAIT_MS = 180_000;
const MAX_BACKOFF_MS = 64_000;

/** Seconds or an HTTP date to milliseconds from `now`; 0 when absent or unreadable. */
function retryAfterMs(header: string | null, now: number): number {
  if (!header) return 0;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

export async function googleRequest(deps: GoogleDeps, req: GoogleRequest): Promise<GoogleResponse> {
  const retryNetwork = req.retryNetwork ?? true;
  let token: string;
  try {
    token = await deps.getToken();
  } catch (err) {
    // A dead refresh token or a disconnected account is the same stop as a rejected one; only an
    // unreachable token endpoint stays a plain (network) error.
    if (isNetworkFailure(err)) throw err;
    throw new GoogleAuthError(req.op, deps.authFix, err instanceof Error ? err.message : String(err));
  }
  let refreshed = false;
  let waited = 0;
  let attempt = 0;
  for (;;) {
    let status: number | null = null;
    let retryAfter = 0;
    const startedAt = deps.now();
    let res: Response | null = null;
    try {
      res = await deps.fetch(req.url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(req.timeoutMs ?? 120_000),
      });
    } catch {
      if (!retryNetwork) {
        throw new Error(`${req.op} failed: network error, not retried`);
      }
    }
    if (res && res.status === 401) {
      if (refreshed) throw new GoogleAuthError(req.op, deps.authFix);
      refreshed = true;
      try {
        token = await deps.getToken(true);
        continue;
      } catch (err) {
        // Revoked grant, expired refresh token, deleted key: Google said no.
        if (!isNetworkFailure(err)) throw new GoogleAuthError(req.op, deps.authFix);
        // The token endpoint was unreachable: retry as a network error.
        res = null;
        refreshed = false;
      }
    }
    if (res && !isRetryable(res.status)) {
      return {
        status: res.status,
        ok: res.ok,
        json: await res.json().catch(() => null),
      };
    }
    if (res) {
      status = res.status;
      retryAfter = retryAfterMs(res.headers.get('retry-after'), deps.now());
    }
    // A request that hung to its timeout used up part of the budget too.
    waited += Math.max(0, deps.now() - startedAt);
    const backoff = Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS) + deps.random() * 1000;
    const delay = Math.max(backoff, retryAfter);
    if (waited + delay > MAX_TOTAL_WAIT_MS) {
      if (status === 429) {
        throw new GoogleQuotaError(req.op, `HTTP 429 after waiting ${Math.round(waited / 1000)} s`);
      }
      throw new Error(
        `${req.op} failed: ${status === null ? 'network error' : `HTTP ${status}`} after waiting ${Math.round(waited / 1000)} s`,
      );
    }
    deps.log(
      'warn',
      `${req.op}: ${status === null ? 'network error' : `HTTP ${status}`}, retry ${attempt + 1} in ${Math.round(delay / 1000)} s`,
    );
    await deps.sleep(delay);
    waited += delay;
    attempt++;
  }
}
