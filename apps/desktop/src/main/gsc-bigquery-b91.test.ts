import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoogleDeps } from './google-retry.js';
import type { FakeBigQuery, FakeLogRow, FakeUrlRow } from './gsc-bq-fake.testkit.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {},
  shell: {},
}));

// Per-file guard: only 127.0.0.1 may be reached (also replaces apiFetch, the clients' default transport).
const guard = vi.hoisted(() => {
  const realFetch = globalThis.fetch;
  return ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(href).hostname;
    if (host !== '127.0.0.1') return Promise.reject(new Error(`guard: blocked host ${host}`));
    return realFetch(input as string, init);
  }) as typeof fetch;
});
vi.mock('./api-fetch.js', () => ({ apiFetch: guard }));
vi.stubGlobal('fetch', guard);

const { startFakeBigQuery } = await import('./gsc-bq-fake.testkit.js');
const bq = await import('./gsc-bigquery.js');
const { GoogleAuthError } = await import('./google-retry.js');

const MIB = 1024 * 1024;
const SITE = 'sc-domain:ex.test';
let fake: FakeBigQuery | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

const days = (s: string, e: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(s); t <= Date.parse(e); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const logFor = (s: string, e: string, epoch = 0, namespace = 'searchdata_url_impression'): FakeLogRow[] =>
  days(s, e).map((date) => ({ namespace, date, epoch }));
const row = (date: string, url: string, clicks: number, impressions: number, pos0: number, over: Partial<FakeUrlRow> = {}): FakeUrlRow => ({
  date, site: SITE, type: 'WEB', url, clicks, impressions, sumPosition: pos0 * impressions, ...over,
});

function deps(over: Partial<GoogleDeps> = {}): GoogleDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    fetch: guard,
    getToken: async () => 'tok',
    sleep: async (ms) => void sleeps.push(ms),
    now: () => Date.now(),
    random: () => 0.5,
    log: () => undefined,
    ...over,
    sleeps,
  };
}
async function start(opts: Parameters<typeof startFakeBigQuery>[0] = {}) {
  fake = await startFakeBigQuery(opts);
  const client = bq.createGscBqClient(
    {
      billingProject: fake.opts.project,
      dataProject: fake.opts.dataProject,
      dataset: fake.opts.dataset,
      apiBase: fake.base,
      pageSize: 2,
    },
    deps(),
  );
  return { fake, client };
}

describe('guard', () => {
  it('rejects a Google host', async () => {
    await expect(guard('https://bigquery.googleapis.com/bigquery/v2/x')).rejects.toThrow(/blocked host/);
  });
});

describe('preflight (three distinct messages)', () => {
  it('returns the dataset location', async () => {
    const { client } = await start({ location: 'EU', exportLog: logFor('2026-09-01', '2026-09-03') });
    await expect(client.preflight()).resolves.toEqual({ location: 'EU' });
  });

  it('missing dataset, missing table and 403 each give their own one-line message', async () => {
    const msgs: string[] = [];
    for (const o of [{ missingDataset: true }, { missingTable: true }]) {
      const { client, fake: f } = await start(o);
      msgs.push(await client.preflight().then(() => 'ok', (e: Error) => e.message));
      await f.close();
      fake = null;
    }
    const { client, fake: f } = await start();
    f.faults.push({ when: (r) => r.kind === 'datasets.get', action: { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Access Denied: SECRET-TEXT', errors: [{ reason: 'accessDenied' }] } } } });
    msgs.push(await client.preflight().then(() => 'ok', (e: Error) => e.message));
    expect(new Set(msgs).size).toBe(3);
    expect(msgs[0]).toMatch(/dataset/i);
    expect(msgs[1]).toMatch(/searchdata_url_impression/);
    expect(msgs[2]).toMatch(/Data Viewer.*Job User/);
    for (const m of msgs) expect(m).not.toMatch(/SECRET-TEXT/);
    for (const m of msgs) expect(m).not.toContain('\n');
  });

  it('a deleted key (401) is the sign-in message', async () => {
    const { fake: f } = await start();
    const client = bq.createGscBqClient(
      { billingProject: 'b', dataProject: 'd', dataset: 'searchconsole', apiBase: f.base },
      deps(),
    );
    f.faults.push({ when: () => true, times: 2, action: { status: 401 } });
    await expect(client.preflight()).rejects.toBeInstanceOf(GoogleAuthError);
  });
});

describe('exportCoverage (r1 H4, r2 M4)', () => {
  it('reads the url-table days with their newest epoch, whichever case the namespace has', async () => {
    for (const ns of ['searchdata_url_impression', 'SEARCHDATA_URL_IMPRESSION']) {
      const { client, fake: f } = await start({
        exportLog: [
          ...logFor('2026-09-01', '2026-09-03', 0, ns),
          { namespace: ns, date: '2026-09-02', epoch: 1 },
          // the site table landed for the 4th, the url table did not
          { namespace: 'searchdata_site_impression', date: '2026-09-04', epoch: 0 },
        ],
      });
      const cov = await client.exportCoverage('EU');
      expect([...cov]).toEqual([['2026-09-01', 0], ['2026-09-02', 1], ['2026-09-03', 0]]);
      await f.close();
      fake = null;
    }
  });

  it('a dataset where the log matches no url-table row stops with a message', async () => {
    const { client } = await start({ exportLog: [{ namespace: 'searchdata_site_impression', date: '2026-09-01', epoch: 0 }] });
    await expect(client.exportCoverage('EU')).rejects.toThrow(/export log/i);
  });

  it('sends the REST contract: standard SQL, location, a ceiling on the bill', async () => {
    const { client, fake: f } = await start({ exportLog: logFor('2026-09-01', '2026-09-01') });
    await client.exportCoverage('EU');
    const q = f.requests.find((r) => r.kind === 'jobs.query')!;
    expect(q.body).toMatchObject({ useLegacySql: false, parameterMode: 'NAMED', location: 'EU' });
    expect(Number(q.body.maximumBytesBilled)).toBeGreaterThan(0);
    expect(q.body.query).toContain('`dataproj.searchconsole.ExportLog`');
  });
});

describe('planParts', () => {
  const ledger = (doneRanges: { start: string; end: string; epochs?: number[] }[]) => ({
    v: 1 as const,
    sourceKey: 'k',
    location: 'EU',
    doneRanges: doneRanges.map((r) => ({
      start: r.start, end: r.end, rows: 1, bytesBilled: 0, at: 'x',
      epochs: r.epochs ?? days(r.start, r.end).map(() => 0),
    })),
    totalBilled: 0,
    inFlight: null,
  });
  const cov = (s: string, e: string, epoch = 0) => new Map(days(s, e).map((d) => [d, epoch] as [string, number]));
  const parts = (p: { parts: { start: string; end: string }[] }) => p.parts.map((x) => `${x.start}..${x.end}`);

  it('cuts a 14-month range at month borders', () => {
    const p = bq.planParts({ start: '2025-08-01', end: '2026-09-30' }, null, cov('2025-08-01', '2026-09-30'));
    expect(p.parts).toHaveLength(14);
    expect(parts(p)[0]).toBe('2025-08-01..2025-08-31');
    expect(parts(p)[1]).toBe('2025-09-01..2025-09-30');
    expect(parts(p)[13]).toBe('2026-09-01..2026-09-30');
    expect(p.coveredDays).toBe(426);
    expect(p.missingDays).toBe(0);
  });

  it('drops done ranges and uncovered days (export started mid-range, a missing day splits a part)', () => {
    const covered = cov('2026-08-10', '2026-09-30');
    covered.delete('2026-09-15');
    const p = bq.planParts({ start: '2026-07-01', end: '2026-09-30' }, ledger([{ start: '2026-08-10', end: '2026-08-31' }]), covered);
    expect(parts(p)).toEqual(['2026-09-01..2026-09-14', '2026-09-16..2026-09-30']);
    expect(p.firstCovered).toBe('2026-08-10');
    // July 1..Aug 9 = 40 days not exported + 15 Sep
    expect(p.missingDays).toBe(41);
  });

  it('the open month later days become a new part', () => {
    const p = bq.planParts({ start: '2026-09-01', end: '2026-09-30' }, ledger([{ start: '2026-09-01', end: '2026-09-10' }]), cov('2026-09-01', '2026-09-14'));
    expect(parts(p)).toEqual(['2026-09-11..2026-09-14']);
  });

  it('a gap day back-filled later is offered by the next plan, around the done ranges (r1 H4)', () => {
    // pulled while 2026-09-05 was missing: two ranges around it
    const l = ledger([{ start: '2026-09-01', end: '2026-09-04' }, { start: '2026-09-06', end: '2026-09-10' }]);
    expect(parts(bq.planParts({ start: '2026-09-01', end: '2026-09-10' }, l, cov('2026-09-01', '2026-09-10')))).toEqual(['2026-09-05..2026-09-05']);
    const stillGap = cov('2026-09-01', '2026-09-10');
    stillGap.delete('2026-09-05');
    const p = bq.planParts({ start: '2026-09-01', end: '2026-09-10' }, l, stillGap);
    expect(p.parts).toEqual([]);
    expect(p.missingDays).toBe(1);
  });

  it('a bumped epoch of a pulled day is reported as revised, not re-planned (also in the last 7 days)', () => {
    const l = ledger([{ start: '2026-08-20', end: '2026-09-14' }]);
    const covered = cov('2026-08-20', '2026-09-14');
    covered.set('2026-08-25', 1);
    covered.set('2026-09-13', 2);
    const p = bq.planParts({ start: '2026-08-20', end: '2026-09-14' }, l, covered);
    expect(p.parts).toEqual([]);
    expect(p.revisedDays).toEqual(['2026-08-25', '2026-09-13']);
  });
});

/** Five URLs over three days, one key repeated inside a day (the export can repeat keys). */
function fixtureRows(over: Partial<FakeUrlRow> = {}): FakeUrlRow[] {
  const rows: FakeUrlRow[] = [];
  for (const d of ['2026-09-01', '2026-09-02', '2026-09-03']) {
    for (let n = 1; n <= 5; n++) rows.push(row(d, `https://ex.test/p${n}`, n, 10 * n, n, over));
  }
  rows.push(row('2026-09-01', 'https://ex.test/p1', 2, 10, 5, over)); // repeated key
  rows.push(row('2026-09-01', null as unknown as string, 9, 9, 1, over)); // anonymized discover: url NULL
  rows.push(row('2026-09-01', 'https://ex.test/other-site', 9, 9, 1, { site: 'sc-domain:other.test', ...over }));
  return rows;
}
const PART = { start: '2026-09-01', end: '2026-09-03' };
async function startWith(target: Partial<Parameters<typeof bq.createGscBqClient>[0]> = {}, opts: Parameters<typeof startFakeBigQuery>[0] = {}) {
  fake = await startFakeBigQuery({ rows: fixtureRows(), exportLog: logFor('2026-09-01', '2026-09-03'), ...opts });
  const d = deps();
  const client = bq.createGscBqClient(
    {
      billingProject: fake.opts.project,
      dataProject: fake.opts.dataProject,
      dataset: fake.opts.dataset,
      siteUrl: SITE,
      searchType: 'web',
      apiBase: fake.base,
      pageSize: 2,
      ...target,
    },
    d,
  );
  await client.preflight();
  return { fake, client, deps: d };
}

describe('estimate (dry run)', () => {
  it('reads totalBytesProcessed and bills nothing', async () => {
    const { client, fake: f } = await startWith();
    await expect(client.estimate(PART)).resolves.toBe(3 * 10 * MIB);
    const dry = f.requests.find((r) => r.kind === 'jobs.query.dry')!;
    expect(dry.body).toMatchObject({ dryRun: true, useLegacySql: false, parameterMode: 'NAMED', location: 'EU' });
    expect(f.mainJobs()).toHaveLength(0);
  });
});

describe('runPart', () => {
  it('sends named parameters, the ceiling and the location; pages 3 result pages; sums repeated keys; takes billed bytes from jobs.get', async () => {
    const { client, fake: f } = await startWith();
    const out = await client.runPart(PART, { jobId: 'fcgsc-test-1', maxBytesBilled: 40 * MIB });
    expect(out.rows).toHaveLength(5);
    const p1 = out.rows.find((r) => r.url === 'https://ex.test/p1')!;
    // p1: 3 days x (1 click, 10 imps, pos 1) + (2 clicks, 10 imps, pos 5)
    expect(p1).toMatchObject({ clicks: 5, impressions: 40 });
    expect(p1.ctr).toBeCloseTo(5 / 40, 12);
    expect(p1.position).toBeCloseTo((3 * 10 * 1 + 10 * 5) / 40 + 1, 12);
    expect(out.bytesBilled).toBe(30 * MIB);
    const insert = f.requests.find((r) => r.kind === 'jobs.insert')!;
    expect(insert.body.jobReference).toMatchObject({ jobId: 'fcgsc-test-1', location: 'EU' });
    const cfg = insert.body.configuration.query;
    expect(cfg).toMatchObject({ useLegacySql: false, parameterMode: 'NAMED', useQueryCache: true, maximumBytesBilled: String(40 * MIB) });
    expect(cfg.queryParameters.map((q: { name: string; parameterValue: { value: string } }) => [q.name, q.parameterValue.value])).toEqual([
      ['s', '2026-09-01'], ['e', '2026-09-03'], ['site', SITE], ['type', 'WEB'],
    ]);
    expect(cfg.query).not.toContain(SITE); // values travel as parameters, not in the SQL text
    expect(cfg.query).toContain('UPPER(search_type) = @type');
    expect(f.requests.filter((r) => r.kind === 'jobs.getQueryResults')).toHaveLength(3);
    for (const r of f.requests.filter((x) => x.kind === 'jobs.getQueryResults' || x.kind === 'jobs.get')) {
      expect(r.search.get('location')).toBe('EU');
    }
  });

  it('settings web and googleNews return rows from upper-case data (r1 H3)', async () => {
    const web = await startWith();
    expect((await web.client.runPart(PART, { jobId: 'a', maxBytesBilled: 40 * MIB })).rows.length).toBe(5);
    await fake!.close();
    const gn = await startWith({ searchType: 'googleNews' }, { rows: fixtureRows({ type: 'GOOGLENEWS' }) });
    expect((await gn.client.runPart(PART, { jobId: 'b', maxBytesBilled: 40 * MIB })).rows.length).toBe(5);
  });

  it('a case difference in the export (lower-case web) cannot return zero rows', async () => {
    const { client } = await startWith({}, { rows: fixtureRows({ type: 'web' }) });
    expect((await client.runPart(PART, { jobId: 'lc', maxBytesBilled: 40 * MIB })).rows).toHaveLength(5);
  });

  it('a job that needs 3 polls still gets its billed bytes from jobs.get', async () => {
    const { client, fake: f } = await startWith({}, { incompletePolls: 2 });
    const out = await client.runPart(PART, { jobId: 'slow', maxBytesBilled: 40 * MIB });
    expect(out.bytesBilled).toBe(30 * MIB);
    expect(out.rows).toHaveLength(5);
    expect(f.jobs.get('slow')!.polls).toBeGreaterThanOrEqual(3);
  });

  it('a dropped insert answer: exactly one job, billed once, rows read (r1 M5)', async () => {
    const { client, fake: f } = await startWith();
    f.faults.push({ when: (r) => r.kind === 'jobs.insert', action: { dropAfter: true } });
    const out = await client.runPart(PART, { jobId: 'dropped', maxBytesBilled: 40 * MIB });
    expect(f.mainJobs()).toHaveLength(1);
    expect(f.requests.filter((r) => r.kind === 'jobs.insert')).toHaveLength(2); // the repeat answered 409
    expect(out.bytesBilled).toBe(30 * MIB);
    expect(out.rows).toHaveLength(5);
  });

  it('a lost insert whose job exists is found by jobs.get before anything is resent', async () => {
    const { client, fake: f } = await startWith();
    // every insert answer is cut: the retries run out, the job is looked up by id
    f.faults.push({ when: (r) => r.kind === 'jobs.insert', times: 99, action: { dropAfter: true } });
    const out = await client.runPart(PART, { jobId: 'lost', maxBytesBilled: 40 * MIB });
    expect(f.mainJobs()).toHaveLength(1);
    expect(out.rows).toHaveLength(5);
  });

  it('finishPart reads a job started before a restart without a second job', async () => {
    const { client, fake: f } = await startWith();
    await client.runPart(PART, { jobId: 'before-restart', maxBytesBilled: 40 * MIB });
    const again = await client.finishPart('before-restart');
    expect(f.mainJobs()).toHaveLength(1);
    expect(again.bytesBilled).toBe(30 * MIB);
    expect(await client.jobStatus('before-restart')).toMatchObject({ state: 'done', billed: 30 * MIB });
    expect((await client.jobStatus('never-existed')).state).toBe('gone');
  });

  it('a ceiling below the real read fails the job without charge: bytes-limit message', async () => {
    const { client } = await startWith();
    const err = await client.runPart(PART, { jobId: 'cap', maxBytesBilled: 12 * MIB }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(bq.BqError);
    expect((err as InstanceType<typeof bq.BqError>).kind).toBe('bytes-limit');
    expect((err as Error).message).toMatch(/cap|ceiling/i);
  });

  it('the fake rejects what the real service rejects: legacy SQL and a poll without location', async () => {
    const { fake: f } = await startWith();
    const post = (body: unknown) => guard(`${f.base}/projects/billing/queries`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.status);
    expect(await post({ query: 'SELECT 1', parameterMode: 'NAMED', location: 'EU', dryRun: true })).toBe(400);
    expect(await post({ query: 'SELECT 1', useLegacySql: false, parameterMode: 'NAMED', dryRun: true })).toBe(400);
    expect((await guard(`${f.base}/projects/billing/queries/x`)).status).toBe(400);
  });

  it('failures: 403 on the query, 429, 5xx and a missing table each stop with a typed or one-line error', async () => {
    const { client, fake: f } = await startWith();
    f.faults.push({ when: (r) => r.kind === 'jobs.insert', action: { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'User does not have bigquery.jobs.create permission in project SECRET' } } } });
    const e403 = await client.runPart(PART, { jobId: 'f1', maxBytesBilled: 40 * MIB }).catch((e: Error) => e);
    expect(bq.describeBqError(e403)).toMatch(/Job User/);
    expect(bq.describeBqError(e403)).not.toMatch(/SECRET/);
    f.faults.push({ when: (r) => r.kind === 'jobs.insert', times: 99, action: { status: 429 } });
    const e429 = await client.runPart(PART, { jobId: 'f2', maxBytesBilled: 40 * MIB }).catch((e: Error) => e);
    expect(e429).toBeInstanceOf((await import('./google-retry.js')).GoogleQuotaError);
    f.faults.length = 0;
    f.faults.push({ when: (r) => r.kind === 'jobs.insert', times: 99, action: { status: 503 } });
    const e5 = await client.runPart(PART, { jobId: 'f3', maxBytesBilled: 40 * MIB }).catch((e: Error) => e);
    expect(bq.describeBqError(e5)).toMatch(/failed/);
    f.faults.length = 0;
    f.faults.push({ when: (r) => r.kind === 'jobs.getQueryResults', action: { status: 404 } });
    const e404 = await client.runPart(PART, { jobId: 'f4', maxBytesBilled: 40 * MIB }).catch((e: Error) => e);
    expect((e404 as InstanceType<typeof bq.BqError>).kind).toBe('not-found');
  });
});

describe('bytesCeiling (r1 L7)', () => {
  it('1.05 x the estimate, or what is left under the cap when that is less, never below 10 MB', () => {
    expect(bq.bytesCeiling(60e6, 100e6, 0)).toBe(63e6);
    expect(bq.bytesCeiling(60e6, 100e6, 60e6)).toBeNull(); // 40 MB left, 60 needed
    expect(bq.bytesCeiling(90e6, 100e6, 8e6)).toBe(92e6); // 92 MB left < 94.5 MB
    expect(bq.bytesCeiling(1e6, 100e6, 0)).toBe(10 * MIB); // floor
  });
});

describe('resolveBqRange and the source key', () => {
  it('all = first..last covered day; presets end at the last covered day; custom as set', () => {
    const cov = new Map(days('2026-06-10', '2026-09-20').map((d) => [d, 0] as [string, number]));
    expect(bq.resolveBqRange({ dateRange: 'all', startDate: '', endDate: '' }, cov)).toEqual({ start: '2026-06-10', end: '2026-09-20' });
    expect(bq.resolveBqRange({ dateRange: '7d', startDate: '', endDate: '' }, cov)).toEqual({ start: '2026-09-14', end: '2026-09-20' });
    expect(bq.resolveBqRange({ dateRange: 'custom', startDate: '2026-07-01', endDate: '2026-07-31' }, cov)).toEqual({ start: '2026-07-01', end: '2026-07-31' });
  });

  it('the source key changes with project, dataset, property and search type', () => {
    const k = bq.bqSourceKey('p', 'searchconsole', SITE, 'web');
    expect(bq.bqSourceKey('p', 'searchconsole', SITE, 'web')).toBe(k);
    for (const other of [bq.bqSourceKey('q', 'searchconsole', SITE, 'web'), bq.bqSourceKey('p', 'searchconsole_2', SITE, 'web'), bq.bqSourceKey('p', 'searchconsole', 'sc-domain:z.com', 'web'), bq.bqSourceKey('p', 'searchconsole', SITE, 'image')]) {
      expect(other).not.toBe(k);
    }
  });
});

describe('parseAggregateRows (r1 L9)', () => {
  it('zero impressions: ctr and position 0, skipped when clicks are 0 too', () => {
    expect(bq.parseAggregateRows([['u1', '3', '0', '0'], ['u2', '0', '0', '0'], ['u3', '2', '8', '16']])).toEqual([
      { url: 'u1', clicks: 3, impressions: 0, ctr: 0, position: 0 },
      { url: 'u3', clicks: 2, impressions: 8, ctr: 0.25, position: 3 },
    ]);
  });
});
