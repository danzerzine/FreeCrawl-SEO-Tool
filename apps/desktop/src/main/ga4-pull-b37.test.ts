import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { mergeGa4Settings, type Ga4FetchMeta, type Ga4IntegrationSettings } from '@freecrawl/shared-types';
import type { GoogleDeps } from './google-retry.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {},
  shell: {},
}));

// Per-file guard (r2-L5): only 127.0.0.1 is reachable; every test passes fake deps anyway.
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', ((input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(href).hostname;
  if (host !== '127.0.0.1') return Promise.reject(new Error(`guard: blocked host ${host}`));
  return realFetch(input as string, init);
}) as typeof fetch);

const { pullGa4, ga4FetchFromDesktop, ga4FetchFromBridge } = await import('./ga4-pull.js');
const { clearMetadataCache } = await import('./ga4.js');

const PROP_A = 'properties/1';
const PROP_B = 'properties/2';
const A = 'https://ex.test/a';
const B = 'https://ex.test/b';
const FIVE = ['sessions', 'activeUsers', 'screenPageViews', 'engagementRate', 'averageSessionDuration'];

interface Body {
  dimensions: { name: string }[];
  metrics: { name: string }[];
  dateRanges: { startDate: string; endDate: string }[];
  offset: number;
  returnPropertyQuota?: boolean;
}
interface Logged {
  kind: 'report' | 'metadata';
  property: string;
  start?: string;
  dims: string[];
  metrics: string[];
}
type Reply = { status: number; body?: unknown };
type Handler = (r: Logged, body: Body) => Reply;

const rowsOf = (list: [string[], string[]][]) => ({
  rows: list.map(([d, m]) => ({ dimensionValues: d.map((value) => ({ value })), metricValues: m.map((value) => ({ value })) })),
  rowCount: list.length,
});
const withQuota = (body: object, remaining: Record<string, number>) => ({
  ...body,
  propertyQuota: Object.fromEntries(Object.entries(remaining).map(([k, v]) => [k, { consumed: 1, remaining: v }])),
});

function fakeGoogle(handler: Handler) {
  const log: Logged[] = [];
  const deps: GoogleDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const property = u.pathname.match(/\/(properties\/\d+)/)![1]!;
      const isMeta = u.pathname.endsWith('/metadata');
      const body = JSON.parse((init.body as string | undefined) ?? '{}') as Body;
      const entry: Logged = isMeta
        ? { kind: 'metadata', property, dims: [], metrics: [] }
        : {
            kind: 'report',
            property,
            start: body.dateRanges[0]!.startDate,
            dims: body.dimensions.map((d) => d.name),
            metrics: body.metrics.map((m) => m.name),
          };
      log.push(entry);
      const r = handler(entry, body);
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
    }) as unknown as GoogleDeps['fetch'],
    getToken: async () => 'tok',
    sleep: async () => {},
    now: () => 0,
    random: () => 0,
    log: () => {},
  };
  return { deps, log, reports: () => log.filter((l) => l.kind === 'report') };
}

const fiveReply = (): Reply => ({
  status: 200,
  body: rowsOf([
    [[A], ['10', '8', '20', '0.5', '30']],
    [[B], ['4', '3', '5', '0.4', '12']],
  ]),
});
const isFive = (r: Logged) => r.metrics.join() === FIVE.join();

let dir: string;
let file: string;
let db: ProjectDb;
beforeEach(() => {
  clearMetadataCache();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b37p-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, status_code, content_type, indexability) VALUES
    (1,'${A}',200,'text/html','indexable'),(2,'${B}',200,'text/html','indexable')`);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-10-22T10:00:00Z');
const input = (over: Record<string, unknown> = {}) => ({
  property: PROP_A,
  propertyName: 'Prop A',
  startDate: '2026-10-01',
  endDate: '2026-10-22',
  accountId: 'acc',
  customMetrics: [] as string[],
  customDimensions: [] as string[],
  ...over,
});
const runPull = (g: ReturnType<typeof fakeGoogle>, over: Record<string, unknown> = {}) =>
  pullGa4(input(over), { db, google: g.deps, now: () => NOW });
const stored = () => db.ga4CustomFieldRowCounts('acc');
const metaOf = (): Ga4FetchMeta => JSON.parse(db.getMeta('ga4FetchMeta:acc')!) as Ga4FetchMeta;
const statusOf = (meta: Ga4FetchMeta, field: string) => meta.customFields!.find((f) => f.field === field)!;

/** A server: five-metric report ok; metrics answer per name; dimension answers per dimension. */
function standard(extra: Handler = () => ({ status: 0 })): Handler {
  return (r, body) => {
    const over = extra(r, body);
    if (over.status !== 0) return over;
    if (r.kind === 'metadata') return { status: 200, body: { dimensions: [], metrics: [] } };
    if (isFive(r)) return fiveReply();
    if (r.dims.length === 2) {
      return { status: 200, body: rowsOf([[[A, `${r.dims[1]}-v1`], ['7']], [[A, `${r.dims[1]}-v2`], ['3']], [[B, `${r.dims[1]}-v1`], ['1']]]) };
    }
    return { status: 200, body: rowsOf([[[A], r.metrics.map((_, i) => String(100 + i))], [[B], r.metrics.map((_, i) => String(200 + i))]]) };
  };
}

describe('B37 pull', () => {
  it('sends the five metrics, then the chosen metrics in one request and one request per dimension', async () => {
    const g = fakeGoogle(standard());
    const res = await runPull(g, {
      customMetrics: ['customEvent:word_count', 'customEvent:reads'],
      customDimensions: ['customEvent:author', 'customUser:plan'],
    });
    const reports = g.reports();
    expect(reports.map((r) => [r.dims.join('+'), r.metrics.join()])).toEqual([
      ['pageLocation', FIVE.join()],
      ['pageLocation', 'customEvent:word_count,customEvent:reads'],
      ['pageLocation+customEvent:author', 'sessions'],
      ['pageLocation+customUser:plan', 'sessions'],
    ]);
    expect(stored()).toEqual({ 'customEvent:word_count': 2, 'customEvent:reads': 2, 'customEvent:author': 3, 'customUser:plan': 3 });
    expect(res.rowCount).toBe(2);
    // the five-metric table is the same as without custom fields
    const t = db.queryGa4({ limit: 10, offset: 0, accountId: 'acc' }).rows.find((r) => r.url === A)!;
    expect(t.ga4).toMatchObject({ sessions: 10, users: 8, pageviews: 20 });
    const meta = metaOf();
    expect(meta.customFields!.map((f) => [f.field, f.kind, f.ok, f.rows])).toEqual([
      ['customEvent:word_count', 'metric', true, 2],
      ['customEvent:reads', 'metric', true, 2],
      ['customEvent:author', 'dimension', true, 3],
      ['customUser:plan', 'dimension', true, 3],
    ]);
    expect(meta.unmatchedUrls).toBe(0);
  });

  it('no custom fields chosen: only the five-metric report, empty customFields, old custom rows cleared', async () => {
    db.storeGa4CustomValues({ accountId: 'acc', property: PROP_A, fetchedAt: 't', fields: ['f'], wipeAll: false, rows: [{ url: A, field: 'f', value: 'x', sessions: 1 }] });
    const g = fakeGoogle(standard());
    await runPull(g);
    expect(g.reports()).toHaveLength(1);
    expect(metaOf().customFields).toEqual([]);
    expect(stored()).toEqual({});
  });

  it('a field with zero rows is ok with rows 0; urls GA4 reports that the crawl lacks are counted', async () => {
    const g = fakeGoogle(
      standard((r) => (r.dims[1] === 'customEvent:author' ? { status: 200, body: { rowCount: 0 } } : r.dims[0] === 'pageLocation' && r.metrics[0] === 'customEvent:reads' ? { status: 200, body: rowsOf([[['https://ex.test/zzz?utm=1'], ['5']]]) } : { status: 0 })),
    );
    await runPull(g, { customMetrics: ['customEvent:reads'], customDimensions: ['customEvent:author'] });
    const meta = metaOf();
    expect(statusOf(meta, 'customEvent:author')).toMatchObject({ ok: true, rows: 0 });
    expect(meta.unmatchedUrls).toBe(1);
  });
});

describe('B37 resume', () => {
  const dims = ['customEvent:author', 'customUser:plan'];
  const failSecond = (state: { fail: boolean }): Handler =>
    standard((r) =>
      state.fail && r.dims[1] === 'customUser:plan' ? { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } } : { status: 0 },
    );

  it('stops on 429 at dimension #2, a second fetch sends only #2 and ends with both listed ok in meta and the tab query', async () => {
    const state = { fail: true };
    const g1 = fakeGoogle(failSecond(state));
    await runPull(g1, { customDimensions: dims });
    expect(stored()).toEqual({ 'customEvent:author': 3 });
    const m1 = metaOf();
    expect(statusOf(m1, 'customEvent:author').ok).toBe(true);
    expect(statusOf(m1, 'customUser:plan')).toMatchObject({ ok: false });
    expect(JSON.parse(db.getMeta('ga4CustomRun:acc')!)).toMatchObject({ property: PROP_A, done: ['customEvent:author'] });

    // what the user is told: the real next step, no promise of «continues tomorrow»
    expect(m1.customMessage).toMatch(/today/i);
    expect(m1.customMessage).not.toMatch(/continues? tomorrow/i);
    expect(m1.customMessage).toContain('customUser:plan');

    state.fail = false;
    const g2 = fakeGoogle(failSecond(state));
    await runPull(g2, { customDimensions: dims });
    const second = g2.reports().filter((r) => r.dims.length === 2);
    expect(second.map((r) => r.dims[1])).toEqual(['customUser:plan']); // only #2
    expect(stored()).toEqual({ 'customEvent:author': 3, 'customUser:plan': 3 });
    // r2-M2: the meta of the resumed pull lists #1 as well as #2
    const m2 = metaOf();
    expect(m2.customFields!.map((f) => [f.field, f.ok, f.rows])).toEqual([
      ['customEvent:author', true, 3],
      ['customUser:plan', true, 3],
    ]);
    const shown = m2.customFields!.filter((f) => f.ok).map((f) => f.field);
    const tab = db.queryGa4({ limit: 10, offset: 0, accountId: 'acc', customFields: shown, customProperty: PROP_A });
    expect(Object.keys(tab.rows.find((r) => r.url === A)!.custom!).sort()).toEqual([...dims].sort());
    expect(db.getMeta('ga4CustomRun:acc')).toBeFalsy(); // finished: record cleared
  });

  it('a resume does not delete the rows already stored; a changed date range sends everything again', async () => {
    const state = { fail: true };
    await runPull(fakeGoogle(failSecond(state)), { customDimensions: dims });
    const before = stored()['customEvent:author'];
    state.fail = true;
    await runPull(fakeGoogle(failSecond(state)), { customDimensions: dims }); // resume, fails again
    expect(stored()['customEvent:author']).toBe(before);
    state.fail = false;
    const g = fakeGoogle(failSecond(state));
    await runPull(g, { customDimensions: dims, startDate: '2026-10-02' }); // other range: fresh
    expect(g.reports().filter((r) => r.dims.length === 2).map((r) => r.dims[1])).toEqual(dims);
  });

  it('a field the user unchose is deleted on the next pull', async () => {
    const state = { fail: true };
    await runPull(fakeGoogle(failSecond(state)), { customDimensions: dims });
    state.fail = false;
    await runPull(fakeGoogle(failSecond(state)), { customDimensions: ['customUser:plan'] });
    expect(stored()).toEqual({ 'customUser:plan': 3 });
  });
});

describe('B37 quota guard', () => {
  const quotaHandler = (remaining: Record<string, number>): Handler =>
    standard((r) =>
      r.dims.length === 2 || r.metrics[0] === 'customEvent:reads'
        ? { status: 200, body: withQuota(rowsOf([[r.dims.length === 2 ? [A, 'v'] : [A], r.dims.length === 2 ? ['3'] : ['1']]]), remaining) }
        : { status: 0 },
    );

  it.each([
    ['tokensPerDay', { tokensPerDay: 3000, tokensPerHour: 30000, tokensPerProjectPerHour: 12000 }],
    ['tokensPerProjectPerHour', { tokensPerDay: 150000, tokensPerHour: 30000, tokensPerProjectPerHour: 3000 }],
    ['tokensPerHour', { tokensPerDay: 150000, tokensPerHour: 3000, tokensPerProjectPerHour: 12000 }],
  ])('%s below 5 000 sends no optional request after the first and names the skipped fields', async (_n, remaining) => {
    const g = fakeGoogle(quotaHandler(remaining));
    await runPull(g, { customMetrics: ['customEvent:reads'], customDimensions: ['customEvent:author', 'customUser:plan'] });
    expect(g.reports()).toHaveLength(2); // five-metric + the metrics request
    const meta = metaOf();
    expect(statusOf(meta, 'customEvent:reads').ok).toBe(true);
    expect(statusOf(meta, 'customEvent:author')).toMatchObject({ ok: false });
    expect(meta.customMessage).toContain('customEvent:author');
    expect(meta.customMessage).toContain('customUser:plan');
  });
});

describe('B37 metrics 400', () => {
  const X = 'customEvent:archived';
  const metricsServer = (opts: { knownInMetadata: boolean; rejectMulti?: boolean }): Handler =>
    standard((r) => {
      if (r.kind === 'metadata') {
        const ms = ['customEvent:a', 'customEvent:b'].concat(opts.knownInMetadata ? [X] : []);
        return { status: 200, body: { dimensions: [], metrics: ms.map((apiName) => ({ apiName, customDefinition: true })) } };
      }
      if (r.dims.length === 1 && !isFive(r)) {
        if (r.metrics.includes(X)) return { status: 400, body: { error: { message: `Field ${X} is not a valid metric` } } };
        if (opts.rejectMulti && r.metrics.length > 1) return { status: 400, body: { error: { message: 'incompatible' } } };
      }
      return { status: 0 };
    });
  const chosen = { customMetrics: ['customEvent:a', X, 'customEvent:b'] };

  it('re-reads metadata, drops the missing metric, retries once and stores the rest', async () => {
    const g = fakeGoogle(metricsServer({ knownInMetadata: false }));
    await runPull(g, chosen);
    const reports = g.reports().filter((r) => !isFive(r));
    expect(reports.map((r) => r.metrics.join())).toEqual([`customEvent:a,${X},customEvent:b`, 'customEvent:a,customEvent:b']);
    expect(g.log.filter((l) => l.kind === 'metadata')).toHaveLength(1);
    expect(stored()).toEqual({ 'customEvent:a': 2, 'customEvent:b': 2 });
    expect(statusOf(metaOf(), X)).toMatchObject({ ok: false, error: expect.stringContaining('not found in the property') as string });
  });

  it('metadata that drops nothing skips the identical retry and goes to one request per metric (r2-L1)', async () => {
    const g = fakeGoogle(metricsServer({ knownInMetadata: true }));
    await runPull(g, chosen);
    expect(g.reports().filter((r) => !isFive(r)).map((r) => r.metrics.join())).toEqual([
      `customEvent:a,${X},customEvent:b`,
      'customEvent:a',
      X,
      'customEvent:b',
    ]);
    expect(stored()).toEqual({ 'customEvent:a': 2, 'customEvent:b': 2 });
    expect(statusOf(metaOf(), X).ok).toBe(false);
    expect(statusOf(metaOf(), X).error).toContain('not a valid metric');
  });

  it('a retry that still fails falls back to one request per metric', async () => {
    const g = fakeGoogle(metricsServer({ knownInMetadata: false, rejectMulti: true }));
    await runPull(g, chosen);
    expect(g.reports().filter((r) => !isFive(r)).map((r) => r.metrics.join())).toEqual([
      `customEvent:a,${X},customEvent:b`,
      'customEvent:a,customEvent:b',
      'customEvent:a',
      'customEvent:b',
    ]);
    expect(stored()).toEqual({ 'customEvent:a': 2, 'customEvent:b': 2 });
  });

  it('the quota guard runs before each fallback request (r2-L1)', async () => {
    const g = fakeGoogle(
      standard((r) => {
        if (r.kind === 'metadata') return { status: 200, body: { metrics: [{ apiName: 'customEvent:a' }, { apiName: X }, { apiName: 'customEvent:b' }] } };
        if (r.dims.length === 1 && !isFive(r) && r.metrics.length > 1) return { status: 400, body: { error: { message: 'bad' } } };
        if (r.metrics[0] === 'customEvent:a') return { status: 200, body: withQuota(rowsOf([[[A], ['1']]]), { tokensPerProjectPerHour: 100 }) };
        return { status: 0 };
      }),
    );
    await runPull(g, chosen);
    expect(g.reports().filter((r) => !isFive(r)).map((r) => r.metrics.join())).toEqual([`customEvent:a,${X},customEvent:b`, 'customEvent:a']);
    expect(statusOf(metaOf(), 'customEvent:b').ok).toBe(false);
  });

  it('a 400 on one dimension does not stop the others', async () => {
    const g = fakeGoogle(
      standard((r) => (r.dims[1] === 'customEvent:gone' ? { status: 400, body: { error: { message: 'Field customEvent:gone is not a valid dimension' } } } : { status: 0 })),
    );
    await runPull(g, { customDimensions: ['customEvent:gone', 'customEvent:author'] });
    expect(stored()).toEqual({ 'customEvent:author': 3 });
    expect(statusOf(metaOf(), 'customEvent:gone')).toMatchObject({ ok: false, error: expect.stringContaining('not a valid dimension') as string });
  });
});

describe('B37 stale data', () => {
  it('property B where the dimension is unregistered leaves no property A rows and nothing for the tab', async () => {
    const dim = 'customEvent:author';
    await runPull(fakeGoogle(standard()), { customDimensions: [dim] });
    expect(stored()).toEqual({ [dim]: 3 });
    const g = fakeGoogle(standard((r) => (r.property === PROP_B && r.dims[1] === dim ? { status: 400, body: { error: { message: 'not a valid dimension' } } } : { status: 0 })));
    await runPull(g, { property: PROP_B, customDimensions: [dim] });
    expect(stored()).toEqual({});
    const meta = metaOf();
    const shown = meta.customFields!.filter((f) => f.ok).map((f) => f.field);
    const tab = db.queryGa4({ limit: 10, offset: 0, accountId: 'acc', customFields: shown, customProperty: meta.property });
    expect(tab.rows.every((r) => !r.custom)).toBe(true);
  });

  it('r2-L2: a first custom request that fails before any answer does not blank the older values', async () => {
    const dim = 'customEvent:author';
    await runPull(fakeGoogle(standard()), { customDimensions: [dim] });
    const before = stored();
    const g = fakeGoogle(standard((r) => (r.dims.length === 2 ? { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } } : { status: 0 })));
    await runPull(g, { customDimensions: [dim], startDate: '2026-10-05' }); // a fresh pull
    expect(stored()).toEqual(before);
    expect(statusOf(metaOf(), dim).ok).toBe(false); // …but the tab does not show them as current
  });

  it('a fresh pull after a failure wipes everything on its first answer, inside one transaction with the insert', async () => {
    const dim = 'customEvent:author';
    await runPull(fakeGoogle(standard()), { customDimensions: [dim] });
    await runPull(fakeGoogle(standard()), { customDimensions: ['customUser:plan'] });
    expect(stored()).toEqual({ 'customUser:plan': 3 });
  });
});

describe('B37 errors', () => {
  it('a rejected sign-in during a custom request fails the pull with the reconnect text', async () => {
    const g = fakeGoogle(standard((r) => (r.dims.length === 2 ? { status: 401 } : { status: 0 })));
    const err = await runPull(g, { customDimensions: ['customEvent:author'] }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/sign-in/i);
    expect(stored()).toEqual({});
  });
});

describe('B37 two entry points share one helper (r1 M2, r2-L3)', () => {
  const settings = (): Ga4IntegrationSettings =>
    mergeGa4Settings({ accountId: 'acc', property: PROP_A, customMetrics: ['customEvent:reads'], customDimensions: ['customEvent:author'] });

  const env = (g: ReturnType<typeof fakeGoogle>, store: { s: Ga4IntegrationSettings }) => ({
    db,
    google: g.deps,
    now: () => NOW,
    resolveAccount: (a?: string) => a || 'acc',
    readSettings: () => store.s,
    writeSettings: (patch: Partial<Ga4IntegrationSettings>) => {
      store.s = { ...store.s, ...patch };
    },
    onChanged: () => {},
  });

  it('the desktop handler and the bridge action send the identical requests and both store customFields', async () => {
    const gDesktop = fakeGoogle(standard());
    const rDesktop = await ga4FetchFromDesktop({ property: PROP_A, propertyName: 'P', days: 28, accountId: 'acc' }, env(gDesktop, { s: settings() }));
    const metaDesktop = metaOf();
    const logDesktop = gDesktop.log.map((l) => [l.kind, l.dims.join('+'), l.metrics.join(), l.start]);

    const gBridge = fakeGoogle(standard());
    const rBridge = await ga4FetchFromBridge({ property: PROP_A, propertyName: 'P', days: 28, accountId: 'acc' }, env(gBridge, { s: settings() }));
    const metaBridge = metaOf();

    expect(gBridge.log.map((l) => [l.kind, l.dims.join('+'), l.metrics.join(), l.start])).toEqual(logDesktop);
    expect(logDesktop.length).toBe(3);
    for (const [r, m] of [[rDesktop, metaDesktop], [rBridge, metaBridge]] as const) {
      expect(r.ok).toBe(true);
      expect(m.customFields!.map((f) => f.field)).toEqual(['customEvent:reads', 'customEvent:author']);
      expect(r.meta!.customFields).toEqual(m.customFields);
    }
  });

  it('keep their own input checks and text', async () => {
    const g = fakeGoogle(standard());
    const store = { s: settings() };
    expect(await ga4FetchFromDesktop({ property: '', propertyName: '', days: 28 }, env(g, store))).toMatchObject({ ok: false, error: 'No GA4 property selected.' });
    expect((await ga4FetchFromBridge({ property: '', propertyName: '', days: 28 }, env(g, store))).error).toContain('property is required');
    expect(g.log).toHaveLength(0);
  });

  it('the desktop entry saves the choice of property; the bridge uses the saved custom lists', async () => {
    const store = { s: mergeGa4Settings({ accountId: 'acc', customDimensions: ['customEvent:author'] }) };
    await ga4FetchFromDesktop({ property: PROP_A, propertyName: 'Prop A', days: 7, accountId: 'acc' }, env(fakeGoogle(standard()), store));
    expect(store.s).toMatchObject({ property: PROP_A, propertyName: 'Prop A', days: 7 });
    expect(store.s.customDimensions).toEqual(['customEvent:author']);
  });

  it('index.ts calls neither report function directly: both handlers are thin callers of the shared entries', () => {
    const src = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
    expect(src).not.toMatch(/ga4RunReport\(/);
    expect(src).toMatch(/ga4FetchFromDesktop\(/);
    expect(src).toMatch(/ga4FetchFromBridge\(/);
  });
});
