/**
 * Faz 7 — Google Analytics 4 API client.
 *
 *   - `listProperties()` — every GA4 property the connected account
 *     can read (Analytics Admin API `accountSummaries`).
 *   - `runReport()` — per-page sessions / users / pageviews /
 *     engagement-rate / avg-session-duration for a date range, joined
 *     against the crawled URLs via the `pageLocation` dimension
 *     (full URL — no host-prefix gymnastics required).
 *
 * Auth runs through the shared OAuth keystone (`google-oauth.ts`) —
 * `getAccessToken('ga4')` mints / refreshes the bearer token; nothing
 * here touches credentials directly.
 */
import type { Ga4Field, Ga4Property } from '@freecrawl/shared-types';
import { getAccessToken } from './google-oauth.js';
import { apiFetch } from './api-fetch.js';
import { googleRequest, throwIfQuotaOrPermission, type GoogleDeps } from './google-retry.js';
import * as logger from './logger.js';

const ADMIN_BASE = 'https://analyticsadmin.googleapis.com/v1beta';
const DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta';
/** GA4 Data API hard cap is 100 000 per request; 25 000 keeps payloads modest. */
const PAGE_LIMIT = 25_000;
/** Hard ceiling so a runaway property can't loop forever. */
const MAX_ROWS = 250_000;

/** Metrics requested (order matters — used by index when parsing rows). */
const METRICS = [
  'sessions',
  'activeUsers',
  'screenPageViews',
  'engagementRate',
  'averageSessionDuration',
] as const;

function apiError(json: unknown, status: number): string {
  const err = (json as { error?: unknown } | null)?.error;
  if (err && typeof err === 'object') {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
  }
  if (status === 403) {
    return 'GA4 denied access — confirm the account can read this property and the Analytics Admin / Data APIs are enabled.';
  }
  return `Google Analytics API error (HTTP ${status})`;
}

function defaultGa4Deps(accountId?: string): GoogleDeps {
  return {
    fetch: apiFetch as unknown as typeof fetch,
    getToken: (refresh) => getAccessToken('ga4', accountId, refresh),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    random: Math.random,
    log: (level, message) => logger.log(level, 'ga4', message),
  };
}

/** Flatten the GA4 Admin `accountSummaries` tree into a flat property list. */
export async function listProperties(
  accountId?: string,
  deps: GoogleDeps = defaultGa4Deps(accountId),
): Promise<Ga4Property[]> {
  const out: Ga4Property[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const url = `${ADMIN_BASE}/accountSummaries?pageSize=200${
      pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
    }`;
    const res = await googleRequest(deps, {
      op: 'GA4 properties',
      method: 'GET',
      url,
      timeoutMs: 30_000,
    });
    const json = res.json as {
      accountSummaries?: {
        displayName?: unknown;
        propertySummaries?: {
          property?: unknown;
          displayName?: unknown;
        }[];
      }[];
      nextPageToken?: unknown;
    } | null;
    if (!res.ok || !json) throw new Error(apiError(json, res.status));

    const summaries = Array.isArray(json.accountSummaries)
      ? json.accountSummaries
      : [];
    for (const acct of summaries) {
      const accountName = typeof acct.displayName === 'string' ? acct.displayName : '';
      const props = Array.isArray(acct.propertySummaries) ? acct.propertySummaries : [];
      for (const p of props) {
        const propertyId = typeof p.property === 'string' ? p.property : '';
        if (!propertyId) continue;
        out.push({
          propertyId,
          displayName:
            typeof p.displayName === 'string' && p.displayName
              ? p.displayName
              : propertyId,
          accountName,
        });
      }
    }
    pageToken = typeof json.nextPageToken === 'string' ? json.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return out;
}

/** One per-page GA4 metrics row. */
export interface Ga4PageRow {
  url: string;
  sessions: number;
  users: number;
  pageviews: number;
  engagementRate: number;
  avgSessionDuration: number;
}

/**
 * Pull per-page metrics for `[startDate, endDate]` (`YYYY-MM-DD`).
 * Transparently pages past `PAGE_LIMIT` rows and returns the flat list.
 */
export async function runReport(
  property: string,
  startDate: string,
  endDate: string,
  accountId?: string,
  deps: GoogleDeps = defaultGa4Deps(accountId),
): Promise<Ga4PageRow[]> {
  const endpoint = `${DATA_BASE}/${property}:runReport`;
  const out: Ga4PageRow[] = [];
  let offset = 0;

  for (;;) {
    const res = await googleRequest(deps, {
      op: 'GA4 report',
      method: 'POST',
      url: endpoint,
      body: {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'pageLocation' }],
        metrics: METRICS.map((name) => ({ name })),
        limit: PAGE_LIMIT,
        offset,
      },
      timeoutMs: 60_000,
    });
    const json = res.json as {
      rows?: {
        dimensionValues?: { value?: unknown }[];
        metricValues?: { value?: unknown }[];
      }[];
      rowCount?: unknown;
    } | null;
    if (!res.ok || !json) throw new Error(apiError(json, res.status));

    const rows = Array.isArray(json.rows) ? json.rows : [];
    for (const r of rows) {
      const url =
        Array.isArray(r.dimensionValues) && r.dimensionValues[0]
          ? String(r.dimensionValues[0].value ?? '')
          : '';
      if (!url) continue;
      const m = Array.isArray(r.metricValues) ? r.metricValues : [];
      const n = (i: number): number =>
        i < m.length ? Number(m[i]?.value ?? 0) || 0 : 0;
      out.push({
        url,
        sessions: n(0),
        users: n(1),
        pageviews: n(2),
        engagementRate: n(3),
        avgSessionDuration: n(4),
      });
    }
    const totalRowCount =
      typeof json.rowCount === 'number' ? json.rowCount : out.length;
    offset += rows.length;
    if (
      rows.length === 0 ||
      offset >= totalRowCount ||
      out.length >= MAX_ROWS
    ) {
      break;
    }
  }
  logger.log(
    'info',
    'ga4',
    `GA4 report: ${out.length} page row(s) for ${property} (${startDate}…${endDate})`,
  );
  return out;
}

/** The Data API refused the request as malformed: an unknown, removed or incompatible field. */
export class Ga4BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Ga4BadRequestError';
  }
}

const metadataCache = new Map<string, Ga4Field[]>();

/** Forget the session's metadata (tests; a property switch does not need it). */
export function clearMetadataCache(): void {
  metadataCache.clear();
}

/**
 * Metrics and dimensions of a property, custom ones included (`GET .../metadata`). Cached in
 * memory per (account, property) for the session and never stored in the project; `refresh`
 * asks again. `customItem:` fields are left out: an item-scoped field cannot be combined with
 * `pageLocation` in a useful way, so the picker does not offer it.
 */
export async function getMetadata(
  property: string,
  accountId?: string,
  deps: GoogleDeps = defaultGa4Deps(accountId),
  opts: { refresh?: boolean } = {},
): Promise<Ga4Field[]> {
  const key = `${accountId ?? ''}|${property}`;
  const cached = metadataCache.get(key);
  if (cached && !opts.refresh) return cached;
  const res = await googleRequest(deps, {
    op: 'GA4 metadata',
    method: 'GET',
    url: `${DATA_BASE}/${property}/metadata`,
    timeoutMs: 30_000,
  });
  const json = res.json as { dimensions?: unknown; metrics?: unknown } | null;
  if (!res.ok || !json) {
    throwIfQuotaOrPermission('GA4 metadata', res.status, json);
    throw new Error(apiError(json, res.status));
  }
  const read = (list: unknown, kind: Ga4Field['kind']): Ga4Field[] =>
    (Array.isArray(list) ? (list as Record<string, unknown>[]) : [])
      .filter((f) => typeof f['apiName'] === 'string' && !(f['apiName'] as string).startsWith('customItem:'))
      .map((f) => ({
        apiName: f['apiName'] as string,
        uiName: typeof f['uiName'] === 'string' ? f['uiName'] : (f['apiName'] as string),
        description: typeof f['description'] === 'string' ? f['description'] : '',
        customDefinition: f['customDefinition'] === true,
        category: typeof f['category'] === 'string' ? f['category'] : '',
        kind,
      }));
  const fields = [...read(json.dimensions, 'dimension'), ...read(json.metrics, 'metric')];
  metadataCache.set(key, fields);
  return fields;
}

/** Remaining Data API tokens as of the last response; a missing bucket is absent. */
export interface Ga4Quota {
  tokensPerDay?: number;
  tokensPerHour?: number;
  tokensPerProjectPerHour?: number;
}

export interface Ga4CustomReportRow {
  dims: string[];
  metrics: string[];
}

const QUOTA_BUCKETS = ['tokensPerDay', 'tokensPerHour', 'tokensPerProjectPerHour'] as const;

/**
 * One report with any dimensions and metrics, paged like {@link runReport}, asking for the
 * property quota so the caller can stop before the budget is gone. Throws
 * {@link Ga4BadRequestError} on HTTP 400 and `GoogleQuotaError` when Google's quota answer persists.
 */
export async function runCustomReport(
  property: string,
  req: { startDate: string; endDate: string; dimensions: string[]; metrics: string[] },
  accountId?: string,
  deps: GoogleDeps = defaultGa4Deps(accountId),
): Promise<{ rows: Ga4CustomReportRow[]; quota: Ga4Quota }> {
  const op = 'GA4 report';
  const endpoint = `${DATA_BASE}/${property}:runReport`;
  const rows: Ga4CustomReportRow[] = [];
  const quota: Ga4Quota = {};
  let offset = 0;
  for (;;) {
    const res = await googleRequest(deps, {
      op,
      method: 'POST',
      url: endpoint,
      body: {
        dateRanges: [{ startDate: req.startDate, endDate: req.endDate }],
        dimensions: req.dimensions.map((name) => ({ name })),
        metrics: req.metrics.map((name) => ({ name })),
        limit: PAGE_LIMIT,
        offset,
        returnPropertyQuota: true,
      },
      timeoutMs: 60_000,
    });
    const json = res.json as {
      rows?: {
        dimensionValues?: { value?: unknown }[];
        metricValues?: { value?: unknown }[];
      }[];
      rowCount?: unknown;
      propertyQuota?: Record<string, { remaining?: unknown } | undefined>;
    } | null;
    if (!res.ok || !json) {
      throwIfQuotaOrPermission(op, res.status, json);
      if (res.status === 400) throw new Ga4BadRequestError(apiError(json, res.status));
      throw new Error(apiError(json, res.status));
    }
    for (const b of QUOTA_BUCKETS) {
      const remaining = json.propertyQuota?.[b]?.remaining;
      if (typeof remaining === 'number') quota[b] = remaining;
    }
    const page = Array.isArray(json.rows) ? json.rows : [];
    for (const r of page) {
      const dims = (r.dimensionValues ?? []).map((d) => String(d?.value ?? ''));
      if (!dims[0]) continue;
      rows.push({ dims, metrics: (r.metricValues ?? []).map((m) => String(m?.value ?? '')) });
    }
    const total = typeof json.rowCount === 'number' ? json.rowCount : rows.length;
    offset += page.length;
    if (page.length === 0 || offset >= total || rows.length >= MAX_ROWS) break;
  }
  return { rows, quota };
}
