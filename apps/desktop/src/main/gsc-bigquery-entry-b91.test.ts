import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { mergeGscSettings, type GscIntegrationSettings } from '@freecrawl/shared-types';
import type { FakeBigQuery, FakeUrlRow } from './gsc-bq-fake.testkit.js';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: {}, shell: {} }));
const guard = vi.hoisted(() => {
  const realFetch = globalThis.fetch;
  return ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(href).hostname !== '127.0.0.1') return Promise.reject(new Error('guard: blocked host'));
    return realFetch(input as string, init);
  }) as typeof fetch;
});
vi.mock('./api-fetch.js', () => ({ apiFetch: guard }));
vi.stubGlobal('fetch', guard);

const { startFakeBigQuery } = await import('./gsc-bq-fake.testkit.js');
const { createGscBqClient } = await import('./gsc-bigquery.js');
const { gscBqCheckEntry, gscBqPlanEntry, gscBqRunEntry, gscBqCancelEntry, newBqSlot } = await import('./gsc-bigquery-entry.js');

const MIB = 1024 * 1024;
const SITE = 'sc-domain:ex.test';
let fake: FakeBigQuery;
let dir: string;
let db: ProjectDb;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b91ent-'));
  db = new ProjectDb(path.join(dir, 'p.seoproject'));
  const dates = ['2026-08-01', '2026-09-01'];
  const rows: FakeUrlRow[] = dates.map((d) => ({ date: d, site: SITE, type: 'WEB', url: 'https://ex.test/a', clicks: 2, impressions: 20, sumPosition: 20 }));
  fake = await startFakeBigQuery({ rows, exportLog: dates.map((d) => ({ namespace: 'searchdata_url_impression', date: d, epoch: 0 })), bytesPerDay: 30 * MIB });
});
afterEach(async () => {
  await fake.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function env(over: Partial<GscIntegrationSettings> = {}, slot = newBqSlot()) {
  const progress: unknown[] = [];
  let changed = 0;
  return {
    slot,
    progress,
    changed: () => changed,
    e: {
      db,
      settings: mergeGscSettings({ source: 'bigquery', property: SITE, dateRange: 'all', bqDataProject: fake.opts.dataProject, ...over }),
      projectId: fake.opts.project,
      makeClient: (target: Parameters<typeof createGscBqClient>[0]) =>
        createGscBqClient({ ...target, apiBase: fake.base }, { fetch: guard, getToken: async () => 't', sleep: async () => undefined, now: () => Date.now(), random: () => 0.5, log: () => undefined }),
      slot,
      now: () => new Date('2026-10-22T00:00:00Z'),
      newPlanId: (() => {
        let n = 0;
        return () => `plan-${++n}`;
      })(),
      onProgress: (p: unknown): void => void progress.push(p),
      onChanged: () => void changed++,
    },
  };
}
const bqRows = () =>
  Number((db as unknown as { db: { prepare(s: string): { get(): any } } }).db.prepare("SELECT COUNT(*) n FROM gsc_results WHERE account_id='bq'").get().n); // eslint-disable-line @typescript-eslint/no-explicit-any

describe('BigQuery pull entries (B91)', () => {
  it('plan, then run that plan: rows stored, progress and change events sent, plan consumed', async () => {
    const { e, progress, changed } = env();
    const plan = await gscBqPlanEntry(e, {});
    expect(plan.ok).toBe(true);
    expect(plan.plan).toMatchObject({ planId: 'plan-1', canRun: true, totalEstimate: 60 * MIB, siteUrl: SITE });
    expect(plan.plan!.parts).toHaveLength(2);
    expect(JSON.stringify(plan.plan)).not.toContain('coverage');
    const res = await gscBqRunEntry(e, { planId: 'plan-1' });
    expect(res).toMatchObject({ ok: true, partsDone: 2, stopped: null, totalBilled: 70 * MIB }); // 2 x 30 MiB parts + the 10 MiB ExportLog query
    expect(bqRows()).toBe(1);
    expect(progress.length).toBeGreaterThan(0);
    expect(changed()).toBeGreaterThan(0);
    const again = await gscBqRunEntry(e, { planId: 'plan-1' });
    expect(again.ok).toBe(false);
  });

  it('the run reads the property and search type of the plan, not of the settings at run time', async () => {
    const { e } = env();
    const plan = await gscBqPlanEntry(e, {});
    expect(plan.ok).toBe(true);
    e.settings = { ...e.settings, property: 'sc-domain:other.test', searchType: 'image' };
    const res = await gscBqRunEntry(e, { planId: 'plan-1' });
    expect(res.ok).toBe(true);
    expect(fake.mainJobs().length).toBeGreaterThan(0);
    for (const j of fake.mainJobs()) {
      expect(j.params['site']).toBe(SITE);
      expect(j.params['type']).toBe('WEB');
    }
  });

  describe('Rebuild is a dry reset (review r1 Medium)', () => {
    const lastCall = async (rows: FakeUrlRow[]) => {
      await fake.close();
      fake = await startFakeBigQuery({
        rows,
        exportLog: ['2026-08-01', '2026-09-01'].map((d) => ({ namespace: 'searchdata_url_impression', date: d, epoch: 0 })),
        bytesPerDay: 60 * MIB,
      });
    };
    const rows = ['2026-08-01', '2026-09-01'].map((d): FakeUrlRow => ({ date: d, site: SITE, type: 'WEB', url: `https://ex.test/${d}`, clicks: 1, impressions: 10, sumPosition: 10 }));

    it('over the cap: planning the rebuild and trying to run it drops nothing', async () => {
      await lastCall(rows);
      const aug = env({ dateRange: 'custom', startDate: '2026-08-01', endDate: '2026-08-31', bqMaxGiB: 0.1 });
      const first = await gscBqPlanEntry(aug.e, {});
      expect((await gscBqRunEntry(aug.e, { planId: first.plan!.planId })).ok).toBe(true);
      expect(bqRows()).toBe(1);
      const before = db.getMeta('gscBqRun');

      const all = env({ dateRange: 'all', bqMaxGiB: 0.1 }, newBqSlot());
      const dry = await gscBqPlanEntry(all.e, { dryReset: true });
      expect(dry.ok).toBe(true);
      expect(dry.plan).toMatchObject({ rebuild: true, overCap: true, canRun: false });
      expect(dry.plan!.parts).toHaveLength(2); // the full range, as if the ledger were empty
      expect(bqRows()).toBe(1);
      expect(db.getMeta('gscBqRun')).toBe(before);
      const run = await gscBqRunEntry(all.e, { planId: dry.plan!.planId });
      expect(run.ok).toBe(false);
      expect(bqRows()).toBe(1);
      expect(db.getMeta('gscBqRun')).toBe(before);
    });

    it('within the cap: the run resets and pulls in one step', async () => {
      await lastCall(rows);
      const aug = env({ dateRange: 'custom', startDate: '2026-08-01', endDate: '2026-08-31', bqMaxGiB: 10 });
      const first = await gscBqPlanEntry(aug.e, {});
      await gscBqRunEntry(aug.e, { planId: first.plan!.planId });
      const all = env({ dateRange: 'all', bqMaxGiB: 10 }, newBqSlot());
      const dry = await gscBqPlanEntry(all.e, { dryReset: true });
      expect(dry.plan).toMatchObject({ rebuild: true, overCap: false, canRun: true });
      expect(bqRows()).toBe(1);
      const run = await gscBqRunEntry(all.e, { planId: dry.plan!.planId });
      expect(run).toMatchObject({ ok: true, partsDone: 2, stopped: null });
      expect(bqRows()).toBe(2);
    });
  });

  it('a run without a plan on screen (unknown id) starts nothing', async () => {
    const { e } = env();
    const res = await gscBqRunEntry(e, { planId: 'made-up' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/plan/i);
    expect(fake.mainJobs()).toHaveLength(0);
  });

  it('a plan on screen runs only under its own id: a made-up or empty id starts nothing and keeps the plan (B185)', async () => {
    const { e } = env();
    const plan = await gscBqPlanEntry(e, {});
    const id = plan.plan!.planId;
    for (const bad of ['made-up', '']) {
      const res = await gscBqRunEntry(e, { planId: bad });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/plan/i);
    }
    expect(fake.mainJobs()).toHaveLength(0);
    expect(bqRows()).toBe(0);
    expect((await gscBqRunEntry(e, { planId: id })).ok).toBe(true);
  });

  it('a plan over the cap cannot run', async () => {
    const { e } = env({ bqMaxGiB: 0.1 });
    fake.data.bytesPerDay = 80 * MIB;
    const plan = await gscBqPlanEntry(e, {});
    expect(plan.plan).toMatchObject({ overCap: true, canRun: false });
    const res = await gscBqRunEntry(e, { planId: plan.plan!.planId });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cap/i);
    expect(fake.mainJobs()).toHaveLength(0);
  });

  it('only one run at a time; cancel stops between parts and keeps the finished one', async () => {
    const { e, slot } = env();
    const plan = await gscBqPlanEntry(e, {});
    e.onProgress = (p: unknown) => {
      if ((p as { done: number }).done === 1) gscBqCancelEntry(slot);
    };
    const first = gscBqRunEntry(e, { planId: plan.plan!.planId });
    const second = await gscBqRunEntry(e, { planId: plan.plan!.planId });
    expect(second.ok).toBe(false);
    const res = await first;
    expect(res.stopped?.reason).toBe('cancelled');
    expect(res.partsDone).toBe(1);
  });

  it('a changed source needs the reset: planning it, with or without a stray reset flag, drops nothing; the dry-reset run resets', async () => {
    const a = env();
    const p = await gscBqPlanEntry(a.e, {});
    await gscBqRunEntry(a.e, { planId: p.plan!.planId });
    db.replaceGscResults([{ url: 'https://ex.test/a', clicks: 9, impressions: 9, ctr: 1, position: 1 }], 't', 'google-acc');
    fake.data.rows.forEach((r) => (r.type = 'IMAGE'));
    const before = bqRows();
    expect(before).toBeGreaterThan(0);
    const b = env({ searchType: 'image' });
    const stale = await gscBqPlanEntry(b.e, {});
    expect(stale.plan).toMatchObject({ needsReset: true, canRun: false });
    // An old caller may still send `reset`: the plan call must not drop anything before the cost is known.
    const stray = await gscBqPlanEntry(b.e, { reset: true } as never);
    expect(bqRows()).toBe(before);
    expect(stray.plan).toMatchObject({ needsReset: true, canRun: false });
    const dry = await gscBqPlanEntry(b.e, { dryReset: true });
    expect(bqRows()).toBe(before);
    expect(dry.plan).toMatchObject({ needsReset: false, rebuild: true, canRun: true });
    const run = await gscBqRunEntry(b.e, { planId: dry.plan!.planId });
    expect(run.ok).toBe(true);
    expect(
      (db as unknown as { db: { prepare(s: string): { get(): any } } }).db.prepare("SELECT COUNT(*) n FROM gsc_results WHERE account_id='google-acc'").get().n, // eslint-disable-line @typescript-eslint/no-explicit-any
    ).toBe(1);
  });

  it('settings problems are one-line errors: wrong source, no project, no property, 403', async () => {
    expect((await gscBqPlanEntry(env({ source: 'api' }).e, {})).error).toMatch(/BigQuery/);
    const noProject = env();
    noProject.e.projectId = '';
    expect((await gscBqPlanEntry(noProject.e, {})).error).toMatch(/project/i);
    expect((await gscBqPlanEntry(env({ property: '' }).e, {})).error).toMatch(/site_url|property/i);
    fake.faults.push({ when: (r) => r.kind === 'datasets.get', action: { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'SECRET' } } } });
    const denied = await gscBqPlanEntry(env().e, {});
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/Data Viewer/);
    expect(denied.error).not.toContain('SECRET');
  });
});

describe('checking the BigQuery source when the tab opens (B181)', () => {
  it('a reachable dataset with the export table is ok, and nothing is queried or billed', async () => {
    expect(await gscBqCheckEntry(env().e)).toEqual({ ok: true, error: null });
    expect(fake.requests.map((r) => r.kind)).toEqual(['datasets.get', 'tables.get']);
  });
  it('a missing project, a wrong dataset or a denied key is reported before any pull', async () => {
    const noProject = env();
    noProject.e.projectId = '';
    expect((await gscBqCheckEntry(noProject.e)).error).toMatch(/project/i);
    const wrong = await gscBqCheckEntry(env({ bqDataset: 'nope' }).e);
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toMatch(/nope/);
    fake.faults.push({ when: (r) => r.kind === 'datasets.get', action: { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'SECRET' } } } });
    const denied = await gscBqCheckEntry(env().e);
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/Data Viewer/);
    expect(denied.error).not.toContain('SECRET');
  });
});
