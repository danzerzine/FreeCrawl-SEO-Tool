/**
 * Yandex Webmaster API client (v4, read calls only).
 *
 *   - `getUserId()` / `listHosts()`: the account behind the token and its hosts.
 *   - `fetchSearchEvents()`: the removal-events list (`search-urls/events/samples`): pages that
 *     appeared in or were removed from search, with Yandex's reason. A history, not a snapshot.
 *   - `fetchBrokenLinks()`: broken internal links (`links/internal/broken/samples`), all kinds.
 *
 * Both lists page 100 rows a time, at most four requests a second, and stop on a short page, on
 * the reported `count`, or at 50 000 rows (the documented maximum of the events list; the same
 * cap is applied to links). Every page goes to `onPage(rows, nextOffset, count)` as it arrives so
 * the caller can save it and resume from `nextOffset`.
 *
 * Auth is a personal OAuth token the caller resolves, so this module stays free of Electron.
 * HTTP, logging, pauses and the base URL come in through `WebmasterDeps` (tests point `baseUrl`
 * at a local server).
 */
import { fetch as undiciFetch } from 'undici';
import {
  trimTrailingSlashes,
  type WebmasterBrokenLinkRow,
  type WebmasterErrorCode,
  type WebmasterEventRow,
  type WebmasterHost,
} from '@freecrawl/shared-types';

const DEFAULT_BASE_URL = 'https://api.webmaster.yandex.net/v4';
const PAGE_LIMIT = 100;
/** Documented maximum rows of the events list. */
export const WEBMASTER_ROW_CAP = 50_000;
/** At most 4 requests a second (own choice, the docs state no limit for these calls). */
const MIN_INTERVAL_MS = 250;
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = 2_000;
const SCOPES = 'webmaster:hostinfo and webmaster:verify';

export interface WebmasterDeps {
  /** Defaults to undici's `fetch`. */
  fetch?: typeof undiciFetch;
  /** Defaults to a no-op. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Pause that ends early (cancelled) on abort. Defaults to a timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Defaults to `https://api.webmaster.yandex.net/v4`. */
  baseUrl?: string;
  /** Clock for the request pace. Defaults to `Date.now`. */
  now?: () => number;
}

export class WebmasterError extends Error {
  constructor(
    message: string,
    readonly code: WebmasterErrorCode,
    readonly status = 0,
    /** For `quota-exceeded`: UTC ISO time at which Yandex's daily quota opens again. */
    readonly exceededUntil: string | null = null,
  ) {
    super(message);
    this.name = 'WebmasterError';
  }
}

/** Yandex dates look like `2016-01-01T00:00:00,000+0300`; `Date.parse` gives NaN on them. */
const YANDEX_DATE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(Z|[+-]\d{2}:?\d{2})?$/;

/** A Yandex date as UTC ISO (`...Z`, milliseconds); null when it cannot be read. */
export function webmasterDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = YANDEX_DATE.exec(value.trim());
  if (!m) return null;
  const ms = Number(((m[7] ?? '0') + '00').slice(0, 3));
  let t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, ms);
  const zone = m[8];
  if (zone && zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  }
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

interface Resolved {
  fetch: typeof undiciFetch;
  log: NonNullable<WebmasterDeps['log']>;
  sleep: NonNullable<WebmasterDeps['sleep']>;
  baseUrl: string;
  now: () => number;
  /** Shared by every call made with the same `deps` object: the pace holds across the phases of a pull. */
  pace: { lastRequestAt: number | null };
}

const paceOf = new WeakMap<object, { lastRequestAt: number | null }>();

/** The text of Yandex's daily quota stop, for the API error and for a refused re-run. */
export function webmasterQuotaText(until: string | null): string {
  return `Yandex Webmaster daily request quota is used up${until ? `; it opens again at ${until}` : ''}.`;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function resolve(deps: WebmasterDeps): Resolved {
  return {
    fetch: deps.fetch ?? undiciFetch,
    log: deps.log ?? (() => {}),
    sleep: deps.sleep ?? defaultSleep,
    baseUrl: trimTrailingSlashes(deps.baseUrl ?? DEFAULT_BASE_URL),
    now: deps.now ?? Date.now,
    pace: paceOf.get(deps) ?? paceOf.set(deps, { lastRequestAt: null }).get(deps)!,
  };
}

const cancelled = (): WebmasterError =>
  new WebmasterError('Yandex Webmaster fetch cancelled.', 'cancelled');
const throwIfCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw cancelled();
};

/** Map a failed answer to a typed error; `retry` says the same request may work later. */
function classify(status: number, json: unknown): { error: WebmasterError; retry: boolean } {
  const body = (json ?? {}) as Record<string, unknown>;
  const errorCode = typeof body.error_code === 'string' ? body.error_code : '';
  const apiMsg =
    typeof body.error_message === 'string' && body.error_message ? body.error_message : '';
  const err = (
    msg: string,
    code: WebmasterErrorCode,
    until: string | null = null,
  ): WebmasterError => new WebmasterError(msg, code, status, until);

  if (status === 429 && errorCode === 'QUOTA_EXCEEDED') {
    const until = webmasterDate(body.exceeded_until);
    return {
      retry: false,
      error: err(
        webmasterQuotaText(until),
        'quota-exceeded',
        until,
      ),
    };
  }
  if (status === 429 || status >= 500) {
    return {
      retry: true,
      error: err(
        apiMsg ? `Yandex Webmaster: ${apiMsg}` : `Yandex Webmaster API error (HTTP ${status})`,
        'api',
      ),
    };
  }
  if (status === 401 || (status === 403 && errorCode === 'INVALID_OAUTH_TOKEN')) {
    return {
      retry: false,
      error: err(
        'Yandex Webmaster rejected the token: paste a new one in Settings (Yandex tokens last about 6 months).',
        'token-rejected',
      ),
    };
  }
  if (status === 403 && errorCode === 'ACCESS_FORBIDDEN') {
    return {
      retry: false,
      error: err(
        `Yandex Webmaster denied access: the token needs the scopes ${SCOPES}.`,
        'access-denied',
      ),
    };
  }
  if (status === 403 && errorCode === 'INVALID_USER_ID') {
    return {
      retry: false,
      error: err('Yandex Webmaster: this user id does not belong to the token.', 'invalid-user'),
    };
  }
  if (status === 404 && errorCode === 'HOST_NOT_VERIFIED') {
    return {
      retry: false,
      error: err(
        'Yandex Webmaster: the host is not verified for this account.',
        'host-not-verified',
      ),
    };
  }
  return {
    retry: false,
    error: err(
      apiMsg ? `Yandex Webmaster: ${apiMsg}` : `Yandex Webmaster API error (HTTP ${status})`,
      'api',
    ),
  };
}

/** GET a path as JSON: paced, with backoff on throttling, 5xx and network errors. */
async function getJson(
  d: Resolved,
  token: string,
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  const url = `${d.baseUrl}${path}${qs ? `?${qs}` : ''}`;
  let last: WebmasterError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    throwIfCancelled(signal);
    if (d.pace.lastRequestAt !== null) {
      const wait = d.pace.lastRequestAt + MIN_INTERVAL_MS - d.now();
      if (wait > 0) await d.sleep(wait, signal);
    }
    d.pace.lastRequestAt = d.now();
    let retry = true;
    try {
      const timeout = AbortSignal.timeout(60_000);
      const res = await d.fetch(url, {
        headers: { Authorization: `OAuth ${token}`, Accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const json = (await res.json().catch(() => null)) as unknown;
      throwIfCancelled(signal);
      if (res.ok && json && typeof json === 'object') return json;
      if (res.ok) {
        last = new WebmasterError(
          'Yandex Webmaster sent an answer this version does not understand.',
          'api',
          res.status,
        );
        retry = false;
      } else {
        const c = classify(res.status, json);
        last = c.error;
        retry = c.retry;
      }
    } catch (err) {
      if (err instanceof WebmasterError) throw err;
      throwIfCancelled(signal);
      // Never echo `err.message`: undici quotes offending header values (the token).
      const name = err instanceof Error ? err.name : 'Error';
      last = new WebmasterError(`Yandex Webmaster request failed (${name})`, 'network');
    }
    if (!retry) throw last;
    if (attempt < MAX_ATTEMPTS) {
      d.log('warn', `${last.message}; retry ${attempt}/${MAX_ATTEMPTS - 1}`);
      await d.sleep(BACKOFF_MS * 2 ** (attempt - 1), signal);
    }
  }
  throw last ?? new WebmasterError('Yandex Webmaster request failed.', 'api');
}

/** The Yandex user id behind the token. */
export async function getUserId(
  token: string,
  deps: WebmasterDeps = {},
  signal?: AbortSignal,
): Promise<number> {
  const json = (await getJson(resolve(deps), token, '/user', {}, signal)) as { user_id?: unknown };
  const id = Number(json.user_id);
  if (!Number.isFinite(id)) {
    throw new WebmasterError('Yandex Webmaster did not return a user id.', 'api');
  }
  return id;
}

/** Every host of the account (verified or not). */
export async function listHosts(
  token: string,
  userId: number,
  deps: WebmasterDeps = {},
  signal?: AbortSignal,
): Promise<WebmasterHost[]> {
  const json = (await getJson(resolve(deps), token, `/user/${userId}/hosts`, {}, signal)) as {
    hosts?: Record<string, unknown>[];
  };
  return (json.hosts ?? []).map((h) => {
    const shown = String(h.unicode_host_url ?? h.ascii_host_url ?? h.host_id ?? '');
    return {
      hostId: String(h.host_id ?? ''),
      hostName: shown.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, ''),
      verified: h.verified === true,
    };
  });
}

export interface WebmasterPageOptions<T> {
  /** Called after every page with its rows, the offset of the next page and the list's `count`. */
  onPage: (rows: T[], nextOffset: number, count: number) => void | Promise<void>;
  /** Continue here instead of at 0. A finished list is resumed at its `count`: only verified. */
  startOffset?: number;
  /** `count` the saved offset belongs to. A different `count` restarts at offset 0 (the list moved). */
  expectedCount?: number;
  /** Called when a changed `count` made the pull restart at offset 0. */
  onRestart?: () => void;
  signal?: AbortSignal;
}

export interface WebmasterPageResult {
  count: number;
  /** Rows delivered to `onPage` by this call. */
  fetched: number;
  truncatedAtCap: boolean;
}

async function fetchPaged<T>(
  token: string,
  deps: WebmasterDeps,
  path: string,
  listKey: string,
  map: (raw: Record<string, unknown>) => T | null,
  opts: WebmasterPageOptions<T>,
): Promise<WebmasterPageResult> {
  const d = resolve(deps);
  let offset = Math.max(0, opts.startOffset ?? 0);
  let expected = opts.expectedCount;
  let fetched = 0;
  let count = expected ?? 0;
  for (;;) {
    if (offset >= WEBMASTER_ROW_CAP)
      return { count, fetched, truncatedAtCap: count > WEBMASTER_ROW_CAP };
    throwIfCancelled(opts.signal);
    const limit = Math.min(PAGE_LIMIT, WEBMASTER_ROW_CAP - offset);
    const json = (await getJson(
      d,
      token,
      path,
      { offset: String(offset), limit: String(limit) },
      opts.signal,
    )) as Record<string, unknown>;
    count = Number(json.count ?? 0) || 0;
    if (expected !== undefined) {
      const mismatch = count !== expected;
      expected = undefined;
      if (mismatch && offset > 0) {
        offset = 0;
        opts.onRestart?.();
        continue;
      }
    }
    const raw = Array.isArray(json[listKey]) ? (json[listKey] as Record<string, unknown>[]) : [];
    const rows = raw.map(map).filter((r): r is T => r !== null);
    if (raw.length > 0) {
      await opts.onPage(rows, offset + raw.length, count);
      fetched += rows.length;
    }
    offset += raw.length;
    if (raw.length < limit || offset >= count) {
      return {
        count,
        fetched,
        truncatedAtCap: offset >= WEBMASTER_ROW_CAP && count > WEBMASTER_ROW_CAP,
      };
    }
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Pages that appeared in or were removed from search, with Yandex's reason. */
export function fetchSearchEvents(
  token: string,
  userId: number,
  hostId: string,
  opts: WebmasterPageOptions<WebmasterEventRow>,
  deps: WebmasterDeps = {},
): Promise<WebmasterPageResult> {
  return fetchPaged(
    token,
    deps,
    `/user/${userId}/hosts/${encodeURIComponent(hostId)}/search-urls/events/samples`,
    'samples',
    (r) => {
      const url = str(r.url);
      if (!url) return null;
      return {
        url,
        title: str(r.title),
        event: str(r.event) ?? '',
        reason: str(r.excluded_url_status),
        badHttpStatus: int(r.bad_http_status),
        targetUrl: str(r.target_url),
        eventDate: webmasterDate(r.event_date),
        lastAccess: webmasterDate(r.last_access),
      };
    },
    opts,
  );
}

/** Broken internal links, every kind (no `indicator` filter). */
export function fetchBrokenLinks(
  token: string,
  userId: number,
  hostId: string,
  opts: WebmasterPageOptions<WebmasterBrokenLinkRow>,
  deps: WebmasterDeps = {},
): Promise<WebmasterPageResult> {
  return fetchPaged(
    token,
    deps,
    `/user/${userId}/hosts/${encodeURIComponent(hostId)}/links/internal/broken/samples`,
    'links',
    (r) => {
      const sourceUrl = str(r.source_url);
      const destinationUrl = str(r.destination_url);
      if (!sourceUrl || !destinationUrl) return null;
      return {
        sourceUrl,
        destinationUrl,
        discoveryDate: webmasterDate(r.discovery_date),
        sourceLastAccessDate: webmasterDate(r.source_last_access_date),
      };
    },
    opts,
  );
}
