/**
 * Test kit for B91: a FAKE BigQuery REST server on 127.0.0.1 (http.createServer). No test reaches
 * googleapis.com. The fake is strict where the real service is: it REJECTS a query request without
 * `useLegacySql:false` / `parameterMode:'NAMED'` / `location`, a poll or `jobs.get` without
 * `location`, returns billed bytes ONLY through `jobs.get`, and matches `search_type` case-sensitively
 * (the data is upper case, as in Google's own samples).
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeUrlRow {
  date: string;
  site: string;
  type: string;
  url: string | null;
  clicks: number;
  impressions: number;
  sumPosition: number;
}
export interface FakeLogRow {
  namespace: string;
  date: string;
  epoch: number;
}
export interface FakeReq {
  method: string;
  path: string;
  search: URLSearchParams;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** What the request is: set when the path is a query job. */
  kind: string;
}
export type FakeFaultAction =
  | { status: number; body?: unknown }
  | { drop: true }
  /** Let the request take effect (e.g. create the job), then cut the connection before the answer. */
  | { dropAfter: true };
export interface FakeFault {
  when: (r: FakeReq) => boolean;
  action: FakeFaultAction;
  /** Stays armed for this many hits (default 1). */
  times?: number;
}
export interface FakeJob {
  id: string;
  kind: 'main' | 'log' | 'distinct' | 'other';
  location: string;
  query: string;
  params: Record<string, string>;
  maximumBytesBilled: number | null;
  useQueryCache: boolean | undefined;
  bytes: number;
  billed: number;
  error: { reason: string; message: string } | null;
  rows: string[][];
  fields: string[];
  polls: number;
  incompleteLeft: number;
}

export interface FakeOpts {
  project?: string;
  dataProject?: string;
  dataset?: string;
  location?: string;
  rows?: FakeUrlRow[];
  exportLog?: FakeLogRow[];
  /** Bytes the partition of one day costs; default 10 MB. */
  bytesPerDay?: number | ((date: string) => number);
  /** `jobComplete:false` answers each main job gives before it completes. */
  incompletePolls?: number;
  missingDataset?: boolean;
  missingTable?: boolean;
}

const MIN_BILLED = 10 * 1024 * 1024;
const U = 'SEARCHDATA_URL_IMPRESSION';

export interface FakeBigQuery {
  base: string;
  opts: Required<Pick<FakeOpts, 'project' | 'dataProject' | 'dataset' | 'location'>>;
  data: { rows: FakeUrlRow[]; exportLog: FakeLogRow[]; bytesPerDay: NonNullable<FakeOpts['bytesPerDay']> };
  jobs: Map<string, FakeJob>;
  requests: FakeReq[];
  faults: FakeFault[];
  incompletePolls: number;
  mainJobs(): FakeJob[];
  close(): Promise<void>;
}

function daysBetween(s: string, e: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(s); t <= Date.parse(e); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export async function startFakeBigQuery(o: FakeOpts = {}): Promise<FakeBigQuery> {
  const project = o.project ?? 'billing';
  const dataProject = o.dataProject ?? 'dataproj';
  const dataset = o.dataset ?? 'searchconsole';
  const location = o.location ?? 'EU';
  const fake: FakeBigQuery = {
    base: '',
    opts: { project, dataProject, dataset, location },
    data: { rows: o.rows ?? [], exportLog: o.exportLog ?? [], bytesPerDay: o.bytesPerDay ?? 10 * 1024 * 1024 },
    jobs: new Map(),
    requests: [],
    faults: [],
    incompletePolls: o.incompletePolls ?? 0,
    mainJobs: () => [...fake.jobs.values()].filter((j) => j.kind === 'main'),
    close: () => new Promise((res) => server.close(() => res())),
  };
  const dayBytes = (d: string) =>
    typeof fake.data.bytesPerDay === 'function' ? fake.data.bytesPerDay(d) : fake.data.bytesPerDay;

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const err = (res: http.ServerResponse, status: number, reason: string, message: string) =>
    json(res, status, { error: { code: status, message, status: reason.toUpperCase(), errors: [{ reason, message }] } });

  /** Run the SQL against the fixture: kind, result table and bytes read. */
  function evaluate(query: string, params: Record<string, string>) {
    if (query.includes('ExportLog')) {
      // The docs give no namespace literal: the compare must be case-insensitive.
      const insensitive = /UPPER\(namespace\)\s*=\s*'SEARCHDATA_URL_IMPRESSION'/.test(query);
      const byDate = new Map<string, number>();
      for (const r of fake.data.exportLog) {
        const hit = insensitive ? r.namespace.toUpperCase() === U : r.namespace === U;
        if (!hit) continue;
        byDate.set(r.date, Math.max(byDate.get(r.date) ?? -1, r.epoch));
      }
      return {
        kind: 'log' as const,
        fields: ['data_date', 'epoch_version'],
        rows: [...byDate].sort().map(([d, n]) => [d, String(n)]),
        bytes: 1024,
      };
    }
    const days = daysBetween(params['s']!, params['e']!);
    const bytes = days.reduce((a, d) => a + dayBytes(d), 0);
    const inScope = fake.data.rows.filter((r) => r.date >= params['s']! && r.date <= params['e']!);
    if (query.includes('DISTINCT site_url')) {
      const seen = new Set<string>();
      for (const r of inScope) seen.add(`${r.site}\u0000${r.type}`);
      return { kind: 'distinct' as const, fields: ['site_url', 'search_type'], rows: [...seen].map((k) => k.split('\u0000')), bytes };
    }
    const upper = query.includes('UPPER(search_type)');
    const sums = new Map<string, [number, number, number]>();
    for (const r of inScope) {
      if (r.site !== params['site'] || r.url === null) continue;
      if ((upper ? r.type.toUpperCase() : r.type) !== params['type']) continue;
      const cur = sums.get(r.url) ?? [0, 0, 0];
      cur[0] += r.clicks;
      cur[1] += r.impressions;
      cur[2] += r.sumPosition;
      sums.set(r.url, cur);
    }
    return {
      kind: 'main' as const,
      fields: ['url', 'clicks', 'impressions', 'sum_position'],
      rows: [...sums].sort().map(([u, v]) => [u, String(v[0]), String(v[1]), String(v[2])]),
      bytes,
    };
  }

  /** Validate a query config the way BigQuery does; null = fine. */
  function badConfig(cfg: any, location: unknown): string | null { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (cfg?.useLegacySql !== false) return 'useLegacySql must be false (legacy SQL has no named parameters)';
    if (cfg?.parameterMode !== 'NAMED') return 'parameterMode must be NAMED';
    if (!location) return 'location is required';
    return null;
  }
  const paramsOf = (cfg: any): Record<string, string> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const out: Record<string, string> = {};
    for (const p of cfg?.queryParameters ?? []) out[p.name] = p.parameterValue?.value;
    return out;
  };

  function createJob(id: string, cfg: any, loc: string): FakeJob { // eslint-disable-line @typescript-eslint/no-explicit-any
    const params = paramsOf(cfg);
    const ev = evaluate(String(cfg.query), params);
    const max = cfg.maximumBytesBilled === undefined ? null : Number(cfg.maximumBytesBilled);
    const billedIfRun = Math.max(MIN_BILLED, ev.bytes);
    const tooBig = max !== null && billedIfRun > max;
    const job: FakeJob = {
      id,
      kind: ev.kind,
      location: loc,
      query: String(cfg.query),
      params,
      maximumBytesBilled: max,
      useQueryCache: cfg.useQueryCache,
      bytes: ev.bytes,
      billed: tooBig ? 0 : billedIfRun,
      error: tooBig
        ? { reason: 'bytesBilledLimitExceeded', message: `Query exceeded limit for bytes billed: ${max}. ${billedIfRun} or higher required.` }
        : null,
      rows: ev.rows,
      fields: ev.fields,
      polls: 0,
      incompleteLeft: ev.kind === 'main' ? fake.incompletePolls : 0,
    };
    fake.jobs.set(id, job);
    return job;
  }

  const jobResource = (j: FakeJob) => ({
    jobReference: { projectId: project, jobId: j.id, location: j.location },
    status: j.error ? { state: 'DONE', errorResult: j.error } : { state: 'DONE' },
    statistics: { query: { totalBytesProcessed: String(j.bytes), totalBytesBilled: String(j.billed), cacheHit: false } },
  });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const path = url.pathname.replace(/^\/bigquery\/v2/, '');
      let kind = 'other';
      if (req.method === 'POST' && path === `/projects/${project}/jobs`) kind = 'jobs.insert';
      else if (req.method === 'POST' && path === `/projects/${project}/queries`) kind = body?.dryRun ? 'jobs.query.dry' : 'jobs.query';
      else if (req.method === 'GET' && path.startsWith(`/projects/${project}/queries/`)) kind = 'jobs.getQueryResults';
      else if (req.method === 'GET' && path.startsWith(`/projects/${project}/jobs/`)) kind = 'jobs.get';
      else if (path.includes('/datasets/') && path.endsWith('/tables/searchdata_url_impression')) kind = 'tables.get';
      else if (path.includes('/datasets/')) kind = 'datasets.get';
      const fr: FakeReq = { method: req.method ?? 'GET', path, search: url.searchParams, body, kind };
      fake.requests.push(fr);

      const fault = fake.faults.find((f) => f.when(fr));
      let after: FakeFaultAction | null = null;
      if (fault) {
        fault.times = (fault.times ?? 1) - 1;
        if (fault.times <= 0) fake.faults.splice(fake.faults.indexOf(fault), 1);
        const a = fault.action;
        if ('drop' in a) return void req.socket.destroy();
        if ('dropAfter' in a) after = a;
        else return json(res, a.status, a.body ?? { error: { code: a.status, message: 'injected', errors: [{ reason: 'injected' }] } });
      }
      const send = (status: number, payload: unknown) => {
        if (after) return void req.socket.destroy();
        json(res, status, payload);
      };

      if (kind === 'datasets.get') {
        if (fake.opts.dataProject && path !== `/projects/${dataProject}/datasets/${dataset}`) return err(res, 404, 'notFound', 'Not found: Dataset');
        if (o.missingDataset) return err(res, 404, 'notFound', 'Not found: Dataset');
        return json(res, 200, { id: `${dataProject}:${dataset}`, location });
      }
      if (kind === 'tables.get') {
        if (o.missingTable) return err(res, 404, 'notFound', 'Not found: Table');
        return json(res, 200, {
          schema: { fields: ['data_date', 'site_url', 'url', 'query', 'search_type', 'impressions', 'clicks', 'sum_position'].map((name) => ({ name })) },
        });
      }
      if (kind === 'jobs.query.dry') {
        const bad = badConfig(body, body.location);
        if (bad) return err(res, 400, 'invalid', bad);
        const ev = evaluate(String(body.query), paramsOf(body));
        return json(res, 200, { jobComplete: true, totalBytesProcessed: String(ev.bytes), cacheHit: false });
      }
      if (kind === 'jobs.query') {
        const bad = badConfig(body, body.location);
        if (bad) return err(res, 400, 'invalid', bad);
        const id = `job_${fake.jobs.size + 1}`;
        const job = createJob(id, body, body.location);
        if (job.error) return err(res, 400, job.error.reason, job.error.message);
        return send(200, {
          jobComplete: true,
          jobReference: { projectId: project, jobId: id, location: job.location },
          schema: { fields: job.fields.map((name) => ({ name })) },
          rows: job.rows.map((r) => ({ f: r.map((v) => ({ v })) })),
          totalRows: String(job.rows.length),
        });
      }
      if (kind === 'jobs.insert') {
        const cfg = body?.configuration?.query;
        const ref = body?.jobReference ?? {};
        const bad = badConfig(cfg, ref.location);
        if (bad) return err(res, 400, 'invalid', bad);
        if (!ref.jobId) return err(res, 400, 'invalid', 'jobId is required');
        if (fake.jobs.has(ref.jobId)) return err(res, 409, 'duplicate', `Already Exists: Job ${project}:${ref.jobId}`);
        const job = createJob(ref.jobId, cfg, ref.location);
        return send(200, jobResource(job));
      }
      if (kind === 'jobs.get') {
        if (!url.searchParams.get('location')) return err(res, 400, 'invalid', 'location is required');
        const id = decodeURIComponent(path.split('/').pop()!);
        const job = fake.jobs.get(id);
        if (!job) return err(res, 404, 'notFound', `Not found: Job ${project}:${id}`);
        return json(res, 200, jobResource(job));
      }
      if (kind === 'jobs.getQueryResults') {
        if (!url.searchParams.get('location')) return err(res, 400, 'invalid', 'location is required');
        const id = decodeURIComponent(path.split('/').pop()!);
        const job = fake.jobs.get(id);
        if (!job) return err(res, 404, 'notFound', `Not found: Job ${project}:${id}`);
        if (job.error) return err(res, 400, job.error.reason, job.error.message);
        job.polls++;
        if (job.incompleteLeft > 0) {
          job.incompleteLeft--;
          return json(res, 200, { jobComplete: false, jobReference: { projectId: project, jobId: id, location: job.location } });
        }
        const max = Number(url.searchParams.get('maxResults') ?? 1000);
        const from = Number(url.searchParams.get('pageToken') ?? 0);
        const slice = job.rows.slice(from, from + max);
        const next = from + max < job.rows.length ? String(from + max) : undefined;
        return json(res, 200, {
          jobComplete: true,
          jobReference: { projectId: project, jobId: id, location: job.location },
          schema: { fields: job.fields.map((name) => ({ name })) },
          rows: slice.map((r) => ({ f: r.map((v) => ({ v })) })),
          totalRows: String(job.rows.length),
          ...(next ? { pageToken: next } : {}),
        });
      }
      err(res, 404, 'notFound', `fake: no route ${req.method} ${path}`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bigquery/v2`;
  return fake;
}
