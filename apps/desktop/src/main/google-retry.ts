/**
 * Retrying request helper shared by the Google Sheets and BigQuery exports.
 *
 * Retries 429, 408, 5xx and network errors with truncated exponential
 * backoff (1, 2, 4 ... 64 s, each plus 0-1 s of jitter); a longer
 * `Retry-After` replaces the computed delay. The total wait per request is
 * capped, then the error names the operation, the last status and the wait.
 * A 401 refreshes the token once. Other 4xx answers are returned as they
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
  let token = await deps.getToken();
  let refreshed = false;
  let waited = 0;
  let attempt = 0;
  for (;;) {
    let status: number | null = null;
    let retryAfter = 0;
    try {
      const res = await deps.fetch(req.url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(req.timeoutMs ?? 120_000),
      });
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        token = await deps.getToken(true);
        continue;
      }
      if (!isRetryable(res.status)) {
        return {
          status: res.status,
          ok: res.ok,
          json: await res.json().catch(() => null),
        };
      }
      status = res.status;
      retryAfter = retryAfterMs(res.headers.get('retry-after'), deps.now());
    } catch {
      if (!retryNetwork) {
        throw new Error(`${req.op} failed: network error, not retried`);
      }
    }
    const backoff = Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS) + deps.random() * 1000;
    const delay = Math.max(backoff, retryAfter);
    if (waited + delay > MAX_TOTAL_WAIT_MS) {
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
