import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { mergeGscSettings, type GscIntegrationSettings } from '@freecrawl/shared-types';
import type { GoogleDeps } from './google-retry.js';
import type { FakeBigQuery, FakeLogRow, FakeUrlRow } from './gsc-bq-fake.testkit.js';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: {}, shell: {} }));
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
const { createGscBqClient } = await import('./gsc-bigquery.js');
const { buildBqPlan, runGscBigQuery, readLedger, resetBigQuery } = await import('./gsc-bigquery-run.js');

const MIB = 1024 * 1024;
const SITE = 'sc-domain:ex.test';
const NOW = new Date('2026-10-22T12:00:00Z');
let fake: FakeBigQuery | null = null;
let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b91run-'));
  db = new ProjectDb(path.join(dir, 'p.seoproject'));
});
afterEach(async () => {
  await fake?.close();
  fake = null;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const row = (date: string, url: string, clicks: number, impressions: number, pos0: number, over: Partial<FakeUrlRow> = {}): FakeUrlRow => ({
  date, site: SITE, type: 'WEB', url, clicks, impressions, sumPosition: pos0 * impressions, ...over,
});
const logRow = (date: string, epoch = 0, namespace = 'searchdata_url_impression'): FakeLogRow => ({ namespace, date, epoch });
const goog = (): GoogleDeps => ({
  fetch: guard, getToken: async () => 'tok', sleep: async () => undefined, now: () => Date.now(), random: () => 0.5, log: () => undefined,
});
const settings = (over: Partial<GscIntegrationSettings> = {}) =>
  mergeGscSettings({ source: 'bigquery', property: SITE, dateRange: 'all', searchType: 'web', bqMaxGiB: 10, ...over });

async function start(opts: Parameters<typeof startFakeBigQuery>[0]) {
  fake = await startFakeBigQuery(opts);
  return fake;
}
const clientFor = (f: FakeBigQuery, over: Partial<GscIntegrationSettings> = {}) =>
  createGscBqClient(
    { billingProject: f.opts.project, dataProject: f.opts.dataProject, dataset: f.opts.dataset, siteUrl: SITE, searchType: settings(over).searchType, apiBase: f.base, pageSize: 3 },
    goog(),
  );
const plan = (f: FakeBigQuery, over: Partial<GscIntegrationSettings> = {}) =>
  buildBqPlan({ client: clientFor(f, over), db, settings: settings(over), dataProject: f.opts.dataProject });
const runDeps = (f: FakeBigQuery, over: { isCancelled?: () => boolean; client?: ReturnType<typeof clientFor> } = {}) => ({
  client: over.client ?? clientFor(f),
  db,
  now: () => NOW,
  isCancelled: over.isCancelled ?? (() => false),
  random: () => 0.123,
});
const stored = (url: string) =>
  (db as unknown as { db: { prepare(s: string): { get(...a: unknown[]): any } } }).db // eslint-disable-line @typescript-eslint/no-explicit-any
    .prepare("SELECT clicks, impressions, ctr, position FROM gsc_results WHERE url = ? AND account_id = 'bq'")
    .get(url) as { clicks: number; impressions: number; ctr: number; position: number } | undefined;
const bqRowCount = () =>
  Number((db as unknown as { db: { prepare(s: string): { get(): any } } }).db.prepare("SELECT COUNT(*) n FROM gsc_results WHERE account_id='bq'").get().n); // eslint-disable-line @typescript-eslint/no-explicit-any

/** Four months, one day each: four parts. Months share URL /a, so merges are exercised. */
function fourMonths(): Parameters<typeof startFakeBigQuery>[0] {
  const dates = ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'];
  const rows: FakeUrlRow[] = [];
  dates.forEach((d, i) => {
    rows.push(row(d, 'https://ex.test/a', i + 1, 100 * (i + 1), i + 1)); // sum_position = pos0 * imps
    rows.push(row(d, `https://ex.test/only-${i}`, 1, 10, 0));
  });
  return { rows, exportLog: dates.map((d) => logRow(d)), bytesPerDay: 20 * MIB };
}

describe('runner: parts, ledger, restart', () => {
  it('failure at part 3: parts 1-2 are merged and in the ledger, 3-4 are not; a second run skips 1-2 and runs 3-4', async () => {
    const f = await start(fourMonths());
    const p = await plan(f);
    expect(p.parts.map((x) => x.start)).toEqual(['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01']);
    f.faults.push({ when: (r) => r.kind === 'jobs.insert' && String(r.body.jobReference.jobId).includes('2026-08-01'), action: { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'x' } } } });
    const first = await runGscBigQuery(runDeps(f), p, {});
    expect(first.partsDone).toBe(2);
    expect(first.stopped?.reason).toBe('error');
    expect(first.stopped?.message).toMatch(/Job User/);
    const ledger = readLedger(db)!;
    expect(ledger.doneRanges.map((r) => r.start)).toEqual(['2026-06-01', '2026-07-01']);
    expect(ledger.totalBilled).toBe(2 * 20 * MIB);
    // rows of parts 1-2 are exactly their totals: /a = (1 click, 100 imps, pos 1+1) + (2, 200, pos 2+1)
    const a = stored('https://ex.test/a')!;
    expect(a.clicks).toBe(3);
    expect(a.impressions).toBe(300);
    expect(a.position).toBeCloseTo((1 * 100 + 2 * 200) / 300 + 1, 12);
    expect(a.ctr).toBeCloseTo(3 / 300, 12);
    expect(stored('https://ex.test/only-2')).toBeUndefined();
    expect(stored('https://ex.test/only-1')).toBeDefined();

    const before = f.mainJobs().length;
    const p2 = await plan(f);
    expect(p2.parts.map((x) => x.start)).toEqual(['2026-08-01', '2026-09-01']);
    const second = await runGscBigQuery(runDeps(f), p2, {});
    expect(second.partsDone).toBe(2);
    expect(second.stopped).toBeNull();
    expect(f.mainJobs().length - before).toBe(2);
    const all = stored('https://ex.test/a')!;
    expect(all.clicks).toBe(1 + 2 + 3 + 4);
    expect(all.impressions).toBe(1000);
    expect(all.position).toBeCloseTo((1 * 100 + 2 * 200 + 3 * 300 + 4 * 400) / 1000 + 1, 12);
    const meta = JSON.parse(db.getMeta('gscFetchMeta:bq')!);
    expect(meta).toMatchObject({ property: SITE, source: 'bigquery', startDate: '2026-06-01', endDate: '2026-09-01', rowCount: 5, bytesBilled: 4 * 20 * MIB });
    expect(meta.gapDays).toBeGreaterThan(0); // the days between the four exported ones
  });

  it('cap: the running billed total stops the run before the next part', async () => {
    const f = await start({ ...fourMonths(), bytesPerDay: 60 * MIB });
    const p = await plan(f, { bqMaxGiB: 0.1 }); // 102.4 MiB
    expect(p.overCap).toBe(true); // 4 x 60 MiB
    expect(p.canRun).toBe(false);
    const res = await runGscBigQuery(runDeps(f), p, {});
    expect(res.partsDone).toBe(1);
    expect(res.stopped?.reason).toBe('cap');
    expect(f.mainJobs()).toHaveLength(1);
    expect(f.mainJobs()[0]!.maximumBytesBilled).toBe(Math.ceil(63 * MIB));
  });

  it('the job ceiling is the cap left in THIS run when that is less than 1.05 x the estimate', async () => {
    const f = await start({ ...fourMonths(), bytesPerDay: (d) => (d === '2026-06-01' ? 10 * MIB : 90 * MIB) });
    const p = await plan(f, { bqMaxGiB: 0.1 });
    // the first part bills 10 MiB, so 92.4 MiB are left for the second (estimate 90 MiB, 1.05 x = 94.5)
    await runGscBigQuery(runDeps(f), { ...p, parts: p.parts.slice(0, 2) }, {});
    const cap = Math.floor(0.1 * 1024 ** 3);
    expect(f.mainJobs()[1]!.maximumBytesBilled).toBe(cap - 10 * MIB);
    expect(cap - 10 * MIB).toBeLessThan(1.05 * 90 * MIB);
  });

  it('cancel between parts keeps the finished ones', async () => {
    const f = await start(fourMonths());
    const p = await plan(f);
    let cancelled = false;
    const deps = runDeps(f, { isCancelled: () => cancelled });
    const origRun = deps.client.runPart.bind(deps.client);
    deps.client.runPart = async (...a: Parameters<typeof origRun>) => {
      const out = await origRun(...a);
      cancelled = true;
      return out;
    };
    const res = await runGscBigQuery(deps, p, {});
    expect(res.partsDone).toBe(1);
    expect(res.stopped?.reason).toBe('cancelled');
    expect(readLedger(db)!.doneRanges).toHaveLength(1);
    expect(bqRowCount()).toBe(2);
  });

  it('restart after jobs.insert returned: the job is found by id, its billed bytes counted, its rows merged, no second job (r2 M6)', async () => {
    const f = await start(fourMonths());
    const p = await plan(f);
    const one = { ...p, parts: p.parts.slice(0, 1) };
    const crashing = runDeps(f);
    const orig = crashing.client.runPart.bind(crashing.client);
    crashing.client.runPart = async (...a: Parameters<typeof orig>) => {
      await orig(...a); // the job exists and is billed
      throw new Error('process killed');
    };
    const crashed = await runGscBigQuery(crashing, one, {});
    expect(crashed.partsDone).toBe(0);
    const left = readLedger(db)!;
    expect(left.inFlight).toMatchObject({ start: '2026-06-01', end: '2026-06-01' });
    expect(left.totalBilled).toBe(0);
    expect(bqRowCount()).toBe(0);

    const jobId = left.inFlight!.jobId;
    const mark = f.requests.length;
    const res = await runGscBigQuery(runDeps(f), one, {});
    expect(res.partsDone).toBe(1);
    expect(f.mainJobs()).toHaveLength(1);
    const after = f.requests.slice(mark).filter((r) => r.kind.startsWith('jobs.'));
    expect(after[0]!.kind).toBe('jobs.get');
    expect(after[0]!.path.endsWith(`/jobs/${jobId}`)).toBe(true);
    expect(after.some((r) => r.kind === 'jobs.insert')).toBe(false);
    const done = readLedger(db)!;
    expect(done.inFlight).toBeNull();
    expect(done.totalBilled).toBe(20 * MIB);
    expect(done.doneRanges).toHaveLength(1);
    expect(bqRowCount()).toBe(2);
  });

  it('a gone job (404) clears inFlight and the part runs once more', async () => {
    const f = await start(fourMonths());
    const p = await plan(f);
    const one = { ...p, parts: p.parts.slice(0, 1) };
    const crashing = runDeps(f);
    crashing.client.runPart = async () => {
      throw new Error('process killed');
    };
    await runGscBigQuery(crashing, one, {});
    expect(readLedger(db)!.inFlight).not.toBeNull();
    f.jobs.clear();
    const res = await runGscBigQuery(runDeps(f), one, {});
    expect(res.partsDone).toBe(1);
    expect(f.mainJobs()).toHaveLength(1);
    expect(readLedger(db)!.inFlight).toBeNull();
  });

  it('a retried insert whose answer was lost: one job, billed once, recorded once (r1 M5)', async () => {
    const f = await start(fourMonths());
    const p = await plan(f);
    f.faults.push({ when: (r) => r.kind === 'jobs.insert', action: { dropAfter: true } });
    const res = await runGscBigQuery(runDeps(f), { ...p, parts: p.parts.slice(0, 1) }, {});
    expect(res.partsDone).toBe(1);
    expect(f.mainJobs()).toHaveLength(1);
    expect(readLedger(db)!.totalBilled).toBe(20 * MIB);
    expect(readLedger(db)!.doneRanges).toHaveLength(1);
  });
});

describe('runner: review r1 fixes (S-High resume double count, adoption, per-run cap, poll failure)', () => {
  const threeDays = (): Parameters<typeof startFakeBigQuery>[0] => {
    const dates = ['2026-10-01', '2026-10-02', '2026-10-03'];
    return {
      rows: dates.map((d) => row(d, 'https://ex.test/a', 1, 10, 0)),
      exportLog: dates.map((d) => logRow(d)),
      bytesPerDay: 20 * MIB,
    };
  };
  const crashAfterInsert = (deps: ReturnType<typeof runDeps>) => {
    const orig = deps.client.runPart.bind(deps.client);
    deps.client.runPart = async (...a: Parameters<typeof orig>) => {
      await orig(...a);
      throw new Error('process killed');
    };
    return deps;
  };

  it('resume after the export grew a day: the in-flight range is recorded once, the plan part is trimmed to the day left (S-High)', async () => {
    const f = await start(threeDays());
    const first = await plan(f, { dateRange: 'custom', startDate: '2026-10-01', endDate: '2026-10-02' });
    await runGscBigQuery(crashAfterInsert(runDeps(f)), first, {});
    expect(readLedger(db)!.inFlight).toMatchObject({ start: '2026-10-01', end: '2026-10-02' });
    const second = await plan(f);
    expect(second.parts.map((x) => [x.start, x.end])).toEqual([['2026-10-01', '2026-10-03']]);
    const res = await runGscBigQuery(runDeps(f), second, {});
    expect(res.stopped).toBeNull();
    const l = readLedger(db)!;
    expect(l.doneRanges.map((r) => [r.start, r.end])).toEqual([['2026-10-01', '2026-10-02'], ['2026-10-03', '2026-10-03']]);
    expect(stored('https://ex.test/a')!.clicks).toBe(3);
    expect(f.mainJobs()).toHaveLength(2);
  });

  it('adopting a new source key drops the old key in-flight job: billed counted, rows not stored under the new key (S-Med)', async () => {
    const f = await start({
      rows: [row('2026-10-01', 'https://ex.test/web', 5, 50, 0), row('2026-10-01', 'https://ex.test/img', 2, 20, 0, { type: 'IMAGE' })],
      exportLog: [logRow('2026-10-01')],
      bytesPerDay: 20 * MIB,
    });
    const webPlan = await plan(f);
    await runGscBigQuery(crashAfterInsert(runDeps(f)), webPlan, {});
    expect(readLedger(db)!.inFlight).not.toBeNull();
    const imgPlan = await plan(f, { searchType: 'image' });
    const res = await runGscBigQuery(runDeps(f, { client: clientFor(f, { searchType: 'image' }) }), imgPlan, {});
    expect(res.stopped).toBeNull();
    expect(res.partsDone).toBe(1);
    expect(res.partsSkipped).toBe(0);
    expect(stored('https://ex.test/web')).toBeUndefined();
    expect(stored('https://ex.test/img')).toBeDefined();
    const l = readLedger(db)!;
    expect(l.sourceKey).toBe(imgPlan.sourceKey);
    expect(l.totalBilled).toBe(40 * MIB); // the old job and the new one
    expect(l.doneRanges).toHaveLength(1);
  });

  it('the cap is per run: bytes billed by earlier pulls do not make a later plan over the cap (S-Med)', async () => {
    const f = await start({ ...fourMonths(), bytesPerDay: 60 * MIB });
    const june = await plan(f, { bqMaxGiB: 0.1, dateRange: 'custom', startDate: '2026-06-01', endDate: '2026-06-30' });
    expect((await runGscBigQuery(runDeps(f), june, {})).partsDone).toBe(1);
    const july = await plan(f, { bqMaxGiB: 0.1, dateRange: 'custom', startDate: '2026-07-01', endDate: '2026-07-31' });
    expect(july.billedSoFar).toBe(60 * MIB); // shown, not compared
    expect(july.overCap).toBe(false);
    expect(july.canRun).toBe(true);
    const res = await runGscBigQuery(runDeps(f), july, {});
    expect(res.stopped).toBeNull();
    expect(res.partsDone).toBe(1);
    expect(res.totalBilled).toBe(120 * MIB);
  });

  it('a poll that fails after jobs.insert keeps inFlight; the next start asks jobs.get and inserts no second job (S-Med)', async () => {
    const f = await start(fourMonths());
    const p = await plan(f);
    const one = { ...p, parts: p.parts.slice(0, 1) };
    f.faults.push({ when: (r) => r.kind === 'jobs.getQueryResults', action: { drop: true }, times: 50 });
    const first = await runGscBigQuery(runDeps(f), one, {});
    expect(first.stopped?.reason).toBe('error');
    expect(f.mainJobs()).toHaveLength(1);
    const left = readLedger(db)!.inFlight;
    expect(left).not.toBeNull();
    f.faults.length = 0;
    const mark = f.requests.length;
    const second = await runGscBigQuery(runDeps(f), one, {});
    expect(second.partsDone).toBe(1);
    expect(f.mainJobs()).toHaveLength(1);
    const after = f.requests.slice(mark).filter((r) => r.kind.startsWith('jobs.'));
    expect(after[0]!.kind).toBe('jobs.get');
    expect(after.some((r) => r.kind === 'jobs.insert')).toBe(false);
    expect(readLedger(db)!.totalBilled).toBe(20 * MIB);
  });
});

describe('runner: empty parts (r1 H3) and the source key', () => {
  it('days listed in ExportLog but zero rows: the run stops, nothing recorded; recorded only with the tick', async () => {
    const f = await start({ rows: [row('2026-09-01', 'https://ex.test/a', 1, 10, 1, { type: 'WEB' })], exportLog: [logRow('2026-09-01')], bytesPerDay: 15 * MIB });
    const p = await plan(f, { searchType: 'image' });
    const res = await runGscBigQuery(runDeps(f, { client: clientFor(f, { searchType: 'image' }) }), p, {});
    expect(res.stopped?.reason).toBe('empty');
    expect(res.stopped?.message).toContain(SITE);
    expect(res.stopped?.message).toContain('WEB');
    const ledger = readLedger(db)!;
    expect(ledger.doneRanges).toEqual([]);
    expect(ledger.totalBilled).toBe(2 * 15 * MIB); // the empty part and the diagnostic query are both billed and counted
    const billed = [...f.jobs.values()].filter((j) => j.kind !== 'log');
    expect(billed.map((j) => j.kind)).toEqual(['main', 'distinct']);
    for (const j of billed) expect(j.maximumBytesBilled).not.toBeNull();

    const ticked = await runGscBigQuery(runDeps(f, { client: clientFor(f, { searchType: 'image' }) }), p, { recordEmpty: true });
    expect(ticked.stopped).toBeNull();
    expect(readLedger(db)!.doneRanges).toHaveLength(1);
    expect(readLedger(db)!.doneRanges[0]!.rows).toBe(0);
  });

  it('a later run with the corrected search type reads those months', async () => {
    const f = await start({ rows: [row('2026-09-01', 'https://ex.test/a', 1, 10, 1)], exportLog: [logRow('2026-09-01')], bytesPerDay: 15 * MIB });
    await runGscBigQuery(runDeps(f, { client: clientFor(f, { searchType: 'image' }) }), await plan(f, { searchType: 'image' }), {});
    const fixed = await plan(f, { searchType: 'web' });
    expect(fixed.needsReset).toBe(false); // nothing was recorded under the wrong key
    const res = await runGscBigQuery(runDeps(f), fixed, {});
    expect(res.partsDone).toBe(1);
    expect(stored('https://ex.test/a')?.clicks).toBe(1);
  });

  it('a changed source key with data in the ledger needs a reset; the reset removes only the bq rows and the ledger', async () => {
    const f = await start(fourMonths());
    await runGscBigQuery(runDeps(f), await plan(f), {});
    db.replaceGscResults([{ url: 'https://ex.test/a', clicks: 9, impressions: 9, ctr: 1, position: 1 }], 't', 'google-acc');
    const other = await plan(f, { searchType: 'image' });
    expect(other.needsReset).toBe(true);
    expect(other.canRun).toBe(false);
    const refused = await runGscBigQuery(runDeps(f), other, {});
    expect(refused.stopped?.reason).toBe('source-changed');
    expect(bqRowCount()).toBe(5);

    resetBigQuery(db);
    expect(bqRowCount()).toBe(0);
    expect(readLedger(db)).toBeNull();
    expect(db.getMeta('gscFetchMeta:bq')).toBeNull();
    expect(db.queryGsc({ limit: 10, offset: 0, accountId: 'google-acc' }).total).toBeGreaterThanOrEqual(0);
    const apiRow = (db as unknown as { db: { prepare(s: string): { get(): any } } }).db.prepare("SELECT clicks FROM gsc_results WHERE account_id='google-acc'").get(); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(apiRow.clicks).toBe(9);
  });
});

describe('plan: coverage over time (r1 H4)', () => {
  it('a day with only a site-table row is not planned; when its url row arrives the next plan offers exactly that day', async () => {
    const dates = ['2026-09-01', '2026-09-02', '2026-09-03'];
    const f = await start({
      rows: dates.map((d) => row(d, 'https://ex.test/a', 1, 10, 1)),
      exportLog: [logRow('2026-09-01'), logRow('2026-09-02'), logRow('2026-09-03', 0, 'searchdata_site_impression')],
    });
    const p1 = await plan(f);
    expect(p1.parts.map((x) => `${x.start}..${x.end}`)).toEqual(['2026-09-01..2026-09-02']);
    await runGscBigQuery(runDeps(f), p1, {});
    f.data.exportLog.push(logRow('2026-09-03'));
    const p2 = await plan(f);
    expect(p2.parts.map((x) => `${x.start}..${x.end}`)).toEqual(['2026-09-03..2026-09-03']);
    expect(p2.canRun).toBe(true);
  });

  it('a gap day back-filled later is offered after the pulled days; the ledger ranges are split around it', async () => {
    const dates = ['2026-09-01', '2026-09-02', '2026-09-04', '2026-09-05'];
    const f = await start({ rows: [...dates, '2026-09-03'].map((d) => row(d, 'https://ex.test/a', 1, 10, 1)), exportLog: dates.map((d) => logRow(d)) });
    const p1 = await plan(f);
    expect(p1.parts.map((x) => `${x.start}..${x.end}`)).toEqual(['2026-09-01..2026-09-02', '2026-09-04..2026-09-05']);
    await runGscBigQuery(runDeps(f), p1, {});
    expect(readLedger(db)!.doneRanges.map((r) => `${r.start}..${r.end}`)).toEqual(['2026-09-01..2026-09-02', '2026-09-04..2026-09-05']);
    f.data.exportLog.push(logRow('2026-09-03'));
    const p2 = await plan(f);
    expect(p2.parts.map((x) => `${x.start}..${x.end}`)).toEqual(['2026-09-03..2026-09-03']);
  });

  it('a bumped epoch_version of a pulled day is reported as revised', async () => {
    const f = await start({ rows: [row('2026-09-01', 'https://ex.test/a', 1, 10, 1)], exportLog: [logRow('2026-09-01')] });
    await runGscBigQuery(runDeps(f), await plan(f), {});
    f.data.exportLog.push(logRow('2026-09-01', 1));
    const p = await plan(f);
    expect(p.revisedDays).toEqual(['2026-09-01']);
    expect(p.parts).toEqual([]);
  });

  it('the dialog numbers: estimate total, share of the free 1 TB, missing days, first covered day', async () => {
    const f = await start({ rows: [row('2026-09-02', 'https://ex.test/a', 1, 10, 1)], exportLog: [logRow('2026-09-02'), logRow('2026-09-04')], bytesPerDay: 100 * MIB });
    const p = await plan(f, { dateRange: 'custom', startDate: '2026-09-01', endDate: '2026-09-04' });
    expect(p.totalEstimate).toBe(200 * MIB);
    expect(p.freeTierShare).toBeCloseTo((200 * MIB) / 1024 ** 4, 12);
    expect(p.missingDays).toBe(2);
    expect(p.firstCovered).toBe('2026-09-02');
    expect(p.capBytes).toBe(10 * 1024 ** 3);
    expect(p.canRun).toBe(true);
  });
});
