/**
 * Yandex Metrica API client.
 *
 *   - `listCounters()` — every counter the token can read (Management API).
 *   - `fetchPageMetrics()` — per-page metrics for a date range from the
 *     Reporting API, joined onto crawl URLs through the caller's
 *     `normalize` function (the crawl's own `normalizeUrl` options).
 *
 * Three reports are pulled, all with `accuracy=full` (unsampled):
 *
 *   1. hit-level   `ym:pv:URL`      → pageviews
 *   2. session     `ym:s:startURL`  → visits, users (by landing page)
 *   3. session     `ym:s:startURL`  → visits filtered to
 *                  `ym:s:trafficSource=='organic'` (search-engine visits)
 *
 * Attribution is left at the API default (cross-device last significant
 * source), which is also the Metrica UI default, so the numbers match
 * what a user sees in the Metrica web interface.
 *
 * Paging: `offset` is 1-based and `limit` tops out at 100 000. For big
 * reports `total_rows` is capped near `offset + limit` (and flagged
 * `total_rows_rounded`), so it can't be used as a stop condition — the
 * loop keeps going until a page comes back short.
 *
 * Auth is a personal OAuth token (`metrika:read`) from the credential
 * store; the caller resolves it so this module stays free of Electron.
 */
import type { MetricaCounter, MetricaFetchMeta } from '@freecrawl/shared-types';
import { apiFetch } from './api-fetch.js';
import * as logger from './logger.js';

const API_BASE = 'https://api-metrika.yandex.net';
/** Reporting API maximum rows per request. */
const PAGE_LIMIT = 100_000;
/** Per-report ceiling so a runaway counter can't exhaust memory. */
const MAX_ROWS = 2_000_000;
/** Attempts per request on HTTP 429 / 5xx / network errors. */
const MAX_ATTEMPTS = 4;

type Totals = MetricaFetchMeta['totals'];

function apiError(json: unknown, status: number): string {
  const msg = (json as { message?: unknown } | null)?.message;
  if (typeof msg === 'string' && msg) return `Yandex Metrica: ${msg}`;
  if (status === 401) {
    return 'Yandex Metrica rejected the token — paste a fresh token with the metrika:read scope in Settings → Integrations.';
  }
  if (status === 403) {
    return 'Yandex Metrica denied access — the token’s account cannot read this counter.';
  }
  return `Yandex Metrica API error (HTTP ${status})`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** GET a Metrica endpoint as JSON, retrying rate limits and server errors. */
async function getJson(
  token: string,
  path: string,
  params: Record<string, string>,
): Promise<unknown> {
  const url = `${API_BASE}${path}?${new URLSearchParams(params).toString()}`;
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await apiFetch(url, {
        headers: { Authorization: `OAuth ${token}` },
        signal: AbortSignal.timeout(120_000),
      });
      const json = (await res.json().catch(() => null)) as unknown;
      if (res.ok && json) return json;
      lastError = apiError(json, res.status);
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      lastError = `Yandex Metrica request failed: ${(err as Error).message}`;
    }
    if (attempt < MAX_ATTEMPTS) {
      logger.log('warn', 'metrica', `${lastError} — retry ${attempt}/${MAX_ATTEMPTS - 1}`);
      await sleep(2_000 * 2 ** (attempt - 1));
    }
  }
  throw new Error(lastError);
}

/** Every counter the token can read. */
export async function listCounters(token: string): Promise<MetricaCounter[]> {
  const PER_PAGE = 1000;
  const out: MetricaCounter[] = [];
  for (let offset = 1; ; offset += PER_PAGE) {
    const json = (await getJson(token, '/management/v1/counters', {
      per_page: String(PER_PAGE),
      offset: String(offset),
    })) as {
      counters?: {
        id?: unknown;
        name?: unknown;
        site?: unknown;
        site2?: { site?: unknown } | null;
        owner_login?: unknown;
      }[];
    };
    const counters = Array.isArray(json.counters) ? json.counters : [];
    for (const c of counters) {
      if (typeof c.id !== 'number' && typeof c.id !== 'string') continue;
      const site =
        typeof c.site2?.site === 'string' ? c.site2.site : typeof c.site === 'string' ? c.site : '';
      out.push({
        counterId: String(c.id),
        name: typeof c.name === 'string' && c.name ? c.name : site || String(c.id),
        site,
        ownerLogin: typeof c.owner_login === 'string' ? c.owner_login : '',
      });
    }
    if (counters.length < PER_PAGE) break;
  }
  return out;
}

interface ReportSpec {
  dimension: string;
  metrics: string[];
  filters?: string;
}

interface ReportResult {
  /** `[raw URL, ...metric values]` per row. */
  rows: { url: string; values: number[] }[];
  /** Whole-range totals per metric, as the API reports them. */
  totals: number[];
  truncated: boolean;
}

/** Pull one report in full, paging until a short page. */
async function runReport(
  token: string,
  counterId: string,
  date1: string,
  date2: string,
  spec: ReportSpec,
): Promise<ReportResult> {
  const rows: ReportResult['rows'] = [];
  let totals: number[] = spec.metrics.map(() => 0);
  let truncated = false;
  for (let offset = 1; ; offset += PAGE_LIMIT) {
    const params: Record<string, string> = {
      ids: counterId,
      date1,
      date2,
      dimensions: spec.dimension,
      metrics: spec.metrics.join(','),
      // Metric desc, then URL, so the order is total and pages can't
      // overlap or skip rows that tie on the metric.
      sort: `-${spec.metrics[0]},${spec.dimension}`,
      accuracy: 'full',
      limit: String(PAGE_LIMIT),
      offset: String(offset),
    };
    if (spec.filters) params['filters'] = spec.filters;
    const json = (await getJson(token, '/stat/v1/data', params)) as {
      data?: { dimensions?: { name?: unknown }[]; metrics?: unknown[] }[];
      totals?: unknown[];
      sampled?: unknown;
    };
    if (json.sampled === true) {
      // accuracy=full should never sample; say so loudly if it ever does.
      logger.log('warn', 'metrica', `report ${spec.dimension} came back sampled`);
    }
    if (offset === 1 && Array.isArray(json.totals)) {
      totals = spec.metrics.map((_, i) => Number(json.totals?.[i] ?? 0) || 0);
    }
    const data = Array.isArray(json.data) ? json.data : [];
    for (const r of data) {
      const url = r.dimensions?.[0]?.name;
      if (typeof url !== 'string' || !url) continue;
      const m = Array.isArray(r.metrics) ? r.metrics : [];
      rows.push({ url, values: spec.metrics.map((_, i) => Number(m[i] ?? 0) || 0) });
    }
    // `total_rows` is capped near offset + limit on large reports, so a
    // short page is the only reliable end-of-data signal.
    if (data.length < PAGE_LIMIT) break;
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      logger.log(
        'warn',
        'metrica',
        `report ${spec.dimension} stopped at ${rows.length} rows (cap)`,
      );
      break;
    }
  }
  return { rows, totals, truncated };
}

/** One per-page Metrica row, keyed by the crawl-normalised URL. */
export interface MetricaPageRow {
  url: string;
  pageviews: number;
  visits: number;
  users: number;
  searchVisits: number;
}

export interface MetricaPageMetrics {
  rows: MetricaPageRow[];
  totals: Totals;
  /** Raw report rows dropped because their URL failed to normalise. */
  dropped: number;
  /** True when a report hit the row ceiling. */
  truncated: boolean;
}

/**
 * Pull per-page metrics for `[date1, date2]` (`YYYY-MM-DD`, counter time
 * zone) and fold them onto crawl URLs. Several raw Metrica URLs can
 * normalise to the same crawl URL (tracking parameters, `#fragments`,
 * host / slash rewrites); their counts are summed. For `users` that sum
 * can count a person once per URL variant — exact for the common case of
 * one variant per page, an upper bound otherwise.
 */
export async function fetchPageMetrics(
  token: string,
  counterId: string,
  date1: string,
  date2: string,
  normalize: (url: string) => string | null,
): Promise<MetricaPageMetrics> {
  const started = Date.now();
  const pv = await runReport(token, counterId, date1, date2, {
    dimension: 'ym:pv:URL',
    metrics: ['ym:pv:pageviews'],
  });
  const sessions = await runReport(token, counterId, date1, date2, {
    dimension: 'ym:s:startURL',
    metrics: ['ym:s:visits', 'ym:s:users'],
  });
  const search = await runReport(token, counterId, date1, date2, {
    dimension: 'ym:s:startURL',
    metrics: ['ym:s:visits'],
    filters: "ym:s:trafficSource=='organic'",
  });

  const byUrl = new Map<string, MetricaPageRow>();
  const normCache = new Map<string, string | null>();
  let dropped = 0;
  const add = (raw: string, apply: (row: MetricaPageRow) => void): void => {
    let url = normCache.get(raw);
    if (url === undefined) {
      url = normalize(raw);
      normCache.set(raw, url);
    }
    if (!url) {
      dropped++;
      return;
    }
    let row = byUrl.get(url);
    if (!row) {
      row = { url, pageviews: 0, visits: 0, users: 0, searchVisits: 0 };
      byUrl.set(url, row);
    }
    apply(row);
  };
  for (const r of pv.rows) add(r.url, (row) => (row.pageviews += r.values[0] ?? 0));
  for (const r of sessions.rows) {
    add(r.url, (row) => {
      row.visits += r.values[0] ?? 0;
      row.users += r.values[1] ?? 0;
    });
  }
  for (const r of search.rows) add(r.url, (row) => (row.searchVisits += r.values[0] ?? 0));

  const rows = [...byUrl.values()];
  logger.log(
    'info',
    'metrica',
    `Metrica report: ${rows.length} page(s) for counter ${counterId} (${date1}…${date2}) from ` +
      `${pv.rows.length}/${sessions.rows.length}/${search.rows.length} raw rows, ` +
      `${dropped} dropped, ${Math.round((Date.now() - started) / 1000)} s`,
  );
  return {
    rows,
    totals: {
      pageviews: pv.totals[0] ?? 0,
      visits: sessions.totals[0] ?? 0,
      users: sessions.totals[1] ?? 0,
      searchVisits: search.totals[0] ?? 0,
    },
    dropped,
    truncated: pv.truncated || sessions.truncated || search.truncated,
  };
}
