/**
 * Search Console bulk export in the user's own BigQuery (B91): the read side.
 *
 * The user turns on the export in Search Console and grants the service account of the BigQuery
 * integration `BigQuery Data Viewer` on the dataset and `BigQuery Job User` on the billing project.
 * FreeCrawl never creates, changes or deletes anything there: it reads the ExportLog and the URL
 * table (per-day partitions), and only through queries that carry `maximumBytesBilled`.
 *
 * Electron-free; every call goes through `googleRequest(deps, ...)` with `deps` injectable.
 * REST contract (spec r1 M4): `useLegacySql:false` and `parameterMode:'NAMED'` on every query,
 * `location` on every job call and poll, billed bytes read from `jobs.get` after the job is done.
 */
import { createHash } from 'node:crypto';
import type { GscSearchType } from '@freecrawl/shared-types';
import {
  GoogleAuthError,
  GooglePermissionError,
  GoogleQuotaError,
  googleRequest,
  throwIfQuotaOrPermission,
  type GoogleDeps,
  type GoogleResponse,
} from './google-retry.js';

export const BIGQUERY_API = 'https://bigquery.googleapis.com/bigquery/v2';
/** BigQuery bills at least 10 MB per table a query touches. */
export const MIN_BILLED_BYTES = 10 * 1024 * 1024;
const URL_TABLE = 'searchdata_url_impression';
const EXPORT_LOG_NAMESPACE = 'SEARCHDATA_URL_IMPRESSION';
const REQUIRED_COLUMNS = ['data_date', 'site_url', 'url', 'search_type', 'impressions', 'clicks', 'sum_position'];
const DAY_MS = 86_400_000;
const POLL_LIMIT_MS = 30 * 60_000;

/** The settings' search types as the export stores them (compared as UPPER(search_type) = @type). */
export const SEARCH_TYPE_VALUES: Record<GscSearchType, string> = {
  web: 'WEB',
  image: 'IMAGE',
  video: 'VIDEO',
  news: 'NEWS',
  discover: 'DISCOVER',
  googleNews: 'GOOGLENEWS',
};

export type BqErrorKind =
  | 'dataset-missing'
  | 'table-missing'
  | 'permission'
  | 'not-found'
  | 'bytes-limit'
  | 'no-export-log'
  | 'policy'
  | 'other';

/** A failure with a one-line message that says what to fix. It never carries Google's error text. */
export class BqError extends Error {
  constructor(
    readonly kind: BqErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'BqError';
  }
}

const PERMISSION_FIX =
  'BigQuery refused access: give the service account "BigQuery Data Viewer" on the Search Console dataset and "BigQuery Job User" on the billing project.';

export interface BqTarget {
  billingProject: string;
  dataProject: string;
  dataset: string;
  siteUrl?: string;
  searchType?: GscSearchType;
  /** Test seam: the fake server's base; default the real REST endpoint. */
  apiBase?: string;
  /** Rows per result page (default 20 000). */
  pageSize?: number;
}

/** A contiguous run of days to pull, all inside one calendar month. */
export interface Part {
  start: string;
  end: string;
  days: number;
}

export interface DoneRange {
  start: string;
  end: string;
  rows: number;
  bytesBilled: number;
  /** `epoch_version` of the url table for each day (start..end) when it was pulled. */
  epochs: number[];
  at: string;
}

export interface GscBqLedger {
  v: 1;
  sourceKey: string;
  location: string;
  doneRanges: DoneRange[];
  totalBilled: number;
  inFlight: null | { jobId: string; start: string; end: string; at: string };
}

/** One aggregated URL as it is stored in `gsc_results`. */
export interface BqUrlRow {
  url: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface JobStatus {
  state: 'gone' | 'running' | 'done' | 'failed';
  billed: number;
  reason?: string;
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function daysOf(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += DAY_MS) out.push(isoDay(t));
  return out;
}

/** Same data (project, dataset, property, search type) = same key; a changed key never mixes into the old rows. */
export function bqSourceKey(dataProject: string, dataset: string, siteUrl: string, searchType: GscSearchType): string {
  return createHash('sha1').update([dataProject, dataset, siteUrl, searchType].join('\u0000')).digest('hex');
}

export function emptyLedger(sourceKey: string, location: string): GscBqLedger {
  return { v: 1, sourceKey, location, doneRanges: [], totalBilled: 0, inFlight: null };
}

export interface BqPlan {
  parts: Part[];
  /** Requested days the url table has a row for. */
  coveredDays: number;
  /** Requested days the export does not hold (yet). */
  missingDays: number;
  /** Pulled days whose epoch grew since: Google revised them, they are not silently ignored. */
  revisedDays: string[];
  firstCovered: string | null;
  lastCovered: string | null;
}

/**
 * The requested range cut to the covered days, minus the exact days in the ledger, split at calendar
 * months and at gaps. A pulled day whose current epoch is higher than the stored one is reported as
 * revised (the last 7 covered days included: that is where Google back-fills and revises).
 */
export function planParts(
  range: { start: string; end: string },
  ledger: GscBqLedger | null,
  coverage: Map<string, number>,
): BqPlan {
  const pulled = new Map<string, number>();
  for (const r of ledger?.doneRanges ?? []) {
    days(r).forEach((d, i) => pulled.set(d, r.epochs[i] ?? 0));
  }
  const requested = daysOf(range.start, range.end);
  const covered = requested.filter((d) => coverage.has(d));
  const parts: Part[] = [];
  let cur: Part | null = null;
  for (const d of covered) {
    if (pulled.has(d)) {
      cur = null;
      continue;
    }
    const next = isoDay(Date.parse(d) - DAY_MS);
    if (cur && cur.end === next && cur.end.slice(0, 7) === d.slice(0, 7)) {
      cur.end = d;
      cur.days++;
    } else {
      cur = { start: d, end: d, days: 1 };
      parts.push(cur);
    }
  }
  const revisedDays = [...pulled.keys()]
    .filter((d) => coverage.has(d) && (coverage.get(d) ?? 0) > (pulled.get(d) ?? 0))
    .sort();
  const all = [...coverage.keys()].sort();
  return {
    parts,
    coveredDays: covered.length,
    missingDays: requested.length - covered.length,
    revisedDays,
    firstCovered: all[0] ?? null,
    lastCovered: all[all.length - 1] ?? null,
  };
}

function days(r: { start: string; end: string }): string[] {
  return daysOf(r.start, r.end);
}

/** The settings' date range as a day range inside what the export holds: presets end at the last covered day. */
export function resolveBqRange(
  settings: { dateRange: string; startDate: string; endDate: string },
  coverage: Map<string, number>,
): { start: string; end: string } | null {
  const all = [...coverage.keys()].sort();
  if (all.length === 0) return null;
  const first = all[0]!;
  const last = all[all.length - 1]!;
  if (settings.dateRange === 'custom' && settings.startDate && settings.endDate) {
    return { start: settings.startDate, end: settings.endDate };
  }
  const back: Record<string, number> = { '7d': 7, '28d': 28, '90d': 90, '16m': 480 };
  const n = back[settings.dateRange];
  if (!n) return { start: first, end: last };
  return { start: isoDay(Date.parse(last) - (n - 1) * DAY_MS), end: last };
}

/**
 * The `maximumBytesBilled` of the next job: 1.05 x the estimate, but never more than what is left
 * under the cap, floor 10 MB. `null` = less than the estimate is left: stop before the part.
 */
export function bytesCeiling(estimate: number, capBytes: number, billedSoFar: number): number | null {
  const remaining = capBytes - billedSoFar;
  const expected = Math.max(estimate, MIN_BILLED_BYTES);
  if (remaining < expected) return null;
  return Math.max(MIN_BILLED_BYTES, Math.min(Math.ceil(estimate * 1.05), remaining));
}

/** One-line, user-facing text of any failure of this module; never the error text of a failed request. */
export function describeBqError(err: unknown): string {
  if (err instanceof BqError) return err.message;
  if (err instanceof GoogleAuthError) {
    return 'Google rejected the BigQuery service-account key: it may be deleted, disabled or pasted wrong (Settings → Integrations → BigQuery).';
  }
  if (err instanceof GooglePermissionError) return PERMISSION_FIX;
  if (err instanceof GoogleQuotaError) return 'BigQuery quota or rate limit reached: try again later.';
  return 'The BigQuery request failed; the finished parts stay saved. Try again.';
}

/** `a.b-c:d` style ids only: they are placed inside backticks of the SQL text. */
function safeId(value: string, what: string): string {
  if (!/^[A-Za-z0-9_.:-]+$/.test(value)) throw new BqError('other', `The ${what} "${value}" has characters BigQuery ids do not allow.`);
  return value;
}

type QueryParam = { name: string; parameterType: { type: string }; parameterValue: { value: string } };
const param = (name: string, type: 'DATE' | 'STRING', value: string): QueryParam => ({
  name,
  parameterType: { type },
  parameterValue: { value },
});

interface ResultPage {
  jobComplete?: boolean;
  jobReference?: { jobId?: string };
  rows?: { f: { v: unknown }[] }[];
  pageToken?: string;
}

export class GscBqClient {
  private location = '';
  private readonly base: string;
  private readonly pageSize: number;

  constructor(
    private readonly target: BqTarget,
    private readonly deps: GoogleDeps,
  ) {
    this.base = target.apiBase ?? BIGQUERY_API;
    this.pageSize = target.pageSize ?? 20_000;
  }

  private get billing(): string {
    return encodeURIComponent(this.target.billingProject);
  }

  private tableRef(table: string): string {
    const t = this.target;
    return `\`${safeId(t.dataProject, 'data project')}.${safeId(t.dataset, 'dataset')}.${table}\``;
  }

  private async call(op: string, method: string, url: string, body?: unknown, retryNetwork = true): Promise<GoogleResponse> {
    const res = await googleRequest(this.deps, { op, method, url, body, timeoutMs: 60_000, retryNetwork });
    try {
      throwIfQuotaOrPermission(op, res.status, res.json);
    } catch (err) {
      // Google's own wording stays out of every message (it can quote the project and the account).
      if (err instanceof GooglePermissionError) throw new BqError('permission', PERMISSION_FIX);
      throw err;
    }
    if (res.status === 403) throw new BqError('permission', PERMISSION_FIX);
    return res;
  }

  /** The reason Google gives for an error answer (a code, not free text). */
  private reasonOf(res: GoogleResponse): string {
    const err = (res.json as { error?: { errors?: { reason?: unknown }[]; status?: unknown } } | null)?.error;
    const reason = err?.errors?.[0]?.reason;
    return typeof reason === 'string' ? reason : typeof err?.status === 'string' ? err.status : '';
  }

  private failed(op: string, res: GoogleResponse): BqError {
    const reason = this.reasonOf(res);
    const text = JSON.stringify((res.json as { error?: unknown } | null)?.error ?? '').toLowerCase();
    if (res.status === 400 && (reason === 'bytesBilledLimitExceeded' || text.includes('bytes billed'))) {
      return new BqError('bytes-limit', 'BigQuery stopped the query before it read more than its byte ceiling; it was not billed. Raise the cap or shorten the range.');
    }
    if (res.status === 404) {
      return new BqError('not-found', 'BigQuery did not find the dataset or table (or the project); check the names in Settings.');
    }
    if (res.status === 400 && /billing|policy|organization|not allowed|disabled/.test(text)) {
      return new BqError('policy', 'BigQuery does not allow queries here (billing disabled or an organisation policy); check the billing project.');
    }
    return new BqError('other', `${op} failed (HTTP ${res.status}).`);
  }

  /** Dataset location (the query jobs must run in it) and the URL table with the columns we read. */
  async preflight(): Promise<{ location: string }> {
    const t = this.target;
    const dsUrl = `${this.base}/projects/${encodeURIComponent(t.dataProject)}/datasets/${encodeURIComponent(t.dataset)}`;
    const ds = await this.call('BigQuery dataset get', 'GET', dsUrl);
    if (ds.status === 404) {
      throw new BqError('dataset-missing', `The dataset "${t.dataset}" was not found in project "${t.dataProject}": check the names in Settings and that the Search Console bulk export is on.`);
    }
    if (!ds.ok) throw this.failed('BigQuery dataset get', ds);
    const location = (ds.json as { location?: unknown } | null)?.location;
    if (typeof location !== 'string' || !location) throw new BqError('other', 'BigQuery did not say where the dataset lives.');
    const tb = await this.call('BigQuery table get', 'GET', `${dsUrl}/tables/${URL_TABLE}`);
    if (tb.status === 404) {
      throw new BqError('table-missing', `The dataset has no ${URL_TABLE} table: the export may not have written its first day yet (up to 48 hours after setup).`);
    }
    if (!tb.ok) throw this.failed('BigQuery table get', tb);
    const fields = (tb.json as { schema?: { fields?: { name?: string }[] } } | null)?.schema?.fields;
    if (Array.isArray(fields)) {
      const have = new Set(fields.map((f) => f.name));
      const missing = REQUIRED_COLUMNS.filter((c) => !have.has(c));
      if (missing.length > 0) {
        throw new BqError('table-missing', `The ${URL_TABLE} table lacks the columns ${missing.join(', ')}: it is not the Search Console export table.`);
      }
    }
    this.location = location;
    return { location };
  }

  private loc(location?: string): string {
    const l = location ?? this.location;
    if (!l) throw new BqError('other', 'Run the preflight first: the dataset location is not known yet.');
    return l;
  }

  /** A small synchronous query (ExportLog); polls when BigQuery does not answer at once. */
  private async smallQuery(sql: string, location: string): Promise<string[][]> {
    const res = await this.call('BigQuery query', 'POST', `${this.base}/projects/${this.billing}/queries`, {
      query: sql,
      useLegacySql: false,
      parameterMode: 'NAMED',
      queryParameters: [],
      location,
      useQueryCache: true,
      maximumBytesBilled: String(MIN_BILLED_BYTES),
      timeoutMs: 30_000,
    });
    if (!res.ok) throw this.failed('BigQuery query', res);
    let page = res.json as ResultPage;
    const jobId = page.jobReference?.jobId ?? '';
    const rows: string[][] = [];
    const startedAt = this.deps.now();
    for (;;) {
      if (page.jobComplete === false) {
        if (!jobId || this.deps.now() - startedAt > POLL_LIMIT_MS) throw new BqError('other', 'BigQuery did not finish a small query in time.');
        await this.deps.sleep(1000);
        page = await this.resultsPage(jobId, location, undefined);
        continue;
      }
      for (const r of page.rows ?? []) rows.push(r.f.map((c) => String(c.v)));
      if (!page.pageToken) return rows;
      page = await this.resultsPage(jobId, location, page.pageToken);
    }
  }

  /** Days the URL table has been exported (ExportLog row for the url table) with their newest epoch. */
  async exportCoverage(location?: string): Promise<Map<string, number>> {
    const sql =
      `SELECT data_date, MAX(epoch_version) AS epoch_version FROM ${this.tableRef('ExportLog')} ` +
      `WHERE UPPER(namespace) = '${EXPORT_LOG_NAMESPACE}' GROUP BY data_date`;
    const rows = await this.smallQuery(sql, this.loc(location));
    if (rows.length === 0) {
      throw new BqError('no-export-log', 'The export log lists no days for the URL table yet: the first export can take up to 48 hours, or the dataset is not a Search Console export.');
    }
    return new Map(rows.map(([d, e]) => [d!, Number(e)] as [string, number]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  }

  private mainSql(): string {
    return (
      'SELECT url, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(sum_position) AS sum_position ' +
      `FROM ${this.tableRef(URL_TABLE)} ` +
      'WHERE data_date BETWEEN @s AND @e AND site_url = @site AND UPPER(search_type) = @type AND url IS NOT NULL GROUP BY url'
    );
  }

  private mainParams(part: { start: string; end: string }): QueryParam[] {
    const t = this.target;
    if (!t.siteUrl || !t.searchType) throw new BqError('other', 'No Search Console property is set for the BigQuery pull.');
    return [
      param('s', 'DATE', part.start),
      param('e', 'DATE', part.end),
      param('site', 'STRING', t.siteUrl),
      param('type', 'STRING', SEARCH_TYPE_VALUES[t.searchType]),
    ];
  }

  /** Dry run: bytes the part will read. Costs nothing, so a repeat is harmless. */
  async estimate(part: { start: string; end: string }, location?: string): Promise<number> {
    const res = await this.call('BigQuery dry run', 'POST', `${this.base}/projects/${this.billing}/queries`, {
      query: this.mainSql(),
      useLegacySql: false,
      parameterMode: 'NAMED',
      queryParameters: this.mainParams(part),
      dryRun: true,
      useQueryCache: true,
      location: this.loc(location),
    });
    if (!res.ok) throw this.failed('BigQuery dry run', res);
    const n = Number((res.json as { totalBytesProcessed?: unknown } | null)?.totalBytesProcessed);
    if (!Number.isFinite(n)) throw new BqError('other', 'BigQuery did not say how many bytes the query reads.');
    return n;
  }

  private async resultsPage(jobId: string, location: string, pageToken: string | undefined): Promise<ResultPage> {
    const q = new URLSearchParams({ location, maxResults: String(this.pageSize), timeoutMs: '10000' });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await this.call(
      'BigQuery query results',
      'GET',
      `${this.base}/projects/${this.billing}/queries/${encodeURIComponent(jobId)}?${q.toString()}`,
    );
    if (!res.ok) throw this.failed('BigQuery query results', res);
    return res.json as ResultPage;
  }

  /** State of a job by id; `gone` after BigQuery dropped it (it keeps jobs for 24 h). */
  async jobStatus(jobId: string, location?: string): Promise<JobStatus> {
    const q = new URLSearchParams({ location: this.loc(location) });
    const res = await this.call('BigQuery job get', 'GET', `${this.base}/projects/${this.billing}/jobs/${encodeURIComponent(jobId)}?${q.toString()}`);
    if (res.status === 404) return { state: 'gone', billed: 0 };
    if (!res.ok) throw this.failed('BigQuery job get', res);
    const j = res.json as {
      status?: { state?: string; errorResult?: { reason?: string } };
      statistics?: { query?: { totalBytesBilled?: unknown } };
    };
    const billed = Number(j.statistics?.query?.totalBytesBilled ?? 0) || 0;
    if (j.status?.errorResult) return { state: 'failed', billed, reason: j.status.errorResult.reason };
    return { state: j.status?.state === 'DONE' ? 'done' : 'running', billed };
  }

  /** Create the job under the client-chosen id; an id that exists (a retried insert landed) is fine. */
  private async insert(jobId: string, sql: string, params: QueryParam[], maxBytes: number, location: string): Promise<void> {
    let res: GoogleResponse;
    try {
      res = await this.call('BigQuery job insert', 'POST', `${this.base}/projects/${this.billing}/jobs`, {
        jobReference: { projectId: this.target.billingProject, jobId, location },
        configuration: {
          query: {
            query: sql,
            useLegacySql: false,
            parameterMode: 'NAMED',
            queryParameters: params,
            maximumBytesBilled: String(maxBytes),
            useQueryCache: true,
          },
        },
      });
    } catch (err) {
      if (err instanceof GoogleAuthError || err instanceof GoogleQuotaError || err instanceof BqError) throw err;
      // The insert's fate is unknown after the retries: ask for the job by id before anything else.
      const st = await this.jobStatus(jobId, location);
      if (st.state === 'gone') throw err;
      return;
    }
    if (res.status === 409) return;
    if (!res.ok) throw this.failed('BigQuery job insert', res);
  }

  /** Wait for the job, then page its rows. Billed bytes come from `jobs.get`, which only a finished job can answer. */
  private async collect(jobId: string, location: string): Promise<{ rows: string[][]; billed: number }> {
    const startedAt = this.deps.now();
    let page = await this.resultsPage(jobId, location, undefined);
    while (page.jobComplete === false) {
      if (this.deps.now() - startedAt > POLL_LIMIT_MS) throw new BqError('other', 'BigQuery did not finish the query in time.');
      await this.deps.sleep(1000);
      page = await this.resultsPage(jobId, location, undefined);
    }
    const st = await this.jobStatus(jobId, location);
    const rows: string[][] = [];
    for (;;) {
      for (const r of page.rows ?? []) rows.push(r.f.map((c) => String(c.v)));
      if (!page.pageToken) break;
      page = await this.resultsPage(jobId, location, page.pageToken);
    }
    return { rows, billed: st.billed };
  }

  /** Run one part under a client-chosen job id (the caller has already written it to the ledger). */
  async runPart(
    part: { start: string; end: string },
    opts: { jobId: string; maxBytesBilled: number },
  ): Promise<{ rows: BqUrlRow[]; bytesBilled: number }> {
    const location = this.loc();
    await this.insert(opts.jobId, this.mainSql(), this.mainParams(part), opts.maxBytesBilled, location);
    return this.finishPart(opts.jobId);
  }

  /** Read the results of a job that was started earlier (restart) or just created. */
  async finishPart(jobId: string): Promise<{ rows: BqUrlRow[]; bytesBilled: number }> {
    const { rows, billed } = await this.collect(jobId, this.loc());
    return { rows: parseAggregateRows(rows), bytesBilled: billed };
  }

  /** Which property and search-type values the export holds for the part's days (a billed query, so capped). */
  async diagnose(
    part: { start: string; end: string },
    opts: { jobId: string; maxBytesBilled: number },
  ): Promise<{ siteUrls: string[]; searchTypes: string[]; bytesBilled: number }> {
    const location = this.loc();
    const sql =
      `SELECT DISTINCT site_url, search_type FROM ${this.tableRef(URL_TABLE)} WHERE data_date BETWEEN @s AND @e`;
    await this.insert(opts.jobId, sql, [param('s', 'DATE', part.start), param('e', 'DATE', part.end)], opts.maxBytesBilled, location);
    const { rows, billed } = await this.collect(opts.jobId, location);
    return {
      siteUrls: [...new Set(rows.map((r) => r[0]!))].sort(),
      searchTypes: [...new Set(rows.map((r) => r[1]!))].sort(),
      bytesBilled: billed,
    };
  }
}

/** SUM rows to stored rows: ctr = clicks / impressions, position = SUM(sum_position) / impressions + 1 ; a URL with no impressions and no clicks is skipped. */
export function parseAggregateRows(rows: string[][]): BqUrlRow[] {
  const out: BqUrlRow[] = [];
  for (const [url, c, i, p] of rows) {
    const clicks = Number(c);
    const impressions = Number(i);
    if (!url || !Number.isFinite(clicks) || !Number.isFinite(impressions)) continue;
    if (impressions <= 0) {
      if (clicks <= 0) continue;
      out.push({ url, clicks, impressions: 0, ctr: 0, position: 0 });
      continue;
    }
    out.push({ url, clicks, impressions, ctr: clicks / impressions, position: Number(p) / impressions + 1 });
  }
  return out;
}

export function createGscBqClient(target: BqTarget, deps: GoogleDeps): GscBqClient {
  return new GscBqClient(target, deps);
}
