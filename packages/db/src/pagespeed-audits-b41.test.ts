import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PagespeedAuditData, PagespeedAudits, PagespeedMetrics } from '@freecrawl/shared-types';
import { runMigrations } from './migrations.js';
import { ProjectDb } from './project-db.js';

const A = 'https://ex.test/a';
const B = 'https://ex.test/b';
const C = 'https://other.test/c';

const metrics = (over: Partial<PagespeedMetrics> = {}): PagespeedMetrics => ({
  performance: 80, lcp: 2000, cls: 0.1, fcp: 1000, tbt: 100, speedIndex: 1500, tti: 3000, maxPotentialFid: 90, inp: null,
  status: 'ok', error: null, fetchedAt: '2026-10-23T10:00:00.000Z', ...over,
});
const audit = (id: string, over: Partial<PagespeedAuditData> = {}): PagespeedAuditData => ({
  auditId: id, kind: 'insight', title: `Title ${id}`, score: 0, displayValue: null, savingsMs: null, savingsBytes: null,
  items: [], itemsTruncated: false, ...over,
});
const audits = (...a: PagespeedAuditData[]): PagespeedAudits => ({ lighthouseVersion: '13.5.0', audits: a });

let dir: string;
let file: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b41-'));
  file = path.join(dir, 'p.seoproject');
  const raw = new DatabaseSync(file);
  runMigrations(raw);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES
    (1, '${A}', 0, 'html', 200), (2, '${B}', 0, 'html', 200), (3, '${C}', 0, 'html', 200)`);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const q = (p: Partial<Parameters<ProjectDb['queryPagespeedAudits']>[0]> = {}) =>
  db.queryPagespeedAudits({ limit: 100, offset: 0, ...p });

describe('B41 R5: audits are written with the metrics row, per url and strategy', () => {
  it('stores the audits with their own date and Lighthouse version, items as a list', () => {
    db.upsertPagespeedResult(A, 'mobile', metrics(), audits(audit('image-delivery-insight', { savingsMs: 1200, savingsBytes: 900, items: [{ url: 'https://ex.test/i.gif', wastedBytes: 900 }], displayValue: 'Est savings of 1 KiB' })));
    const { rows, total } = q({ url: A });
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({
      url: A, strategy: 'mobile', auditId: 'image-delivery-insight', kind: 'insight', title: 'Title image-delivery-insight',
      score: 0, displayValue: 'Est savings of 1 KiB', savingsMs: 1200, savingsBytes: 900, itemsTruncated: false, lighthouseVersion: '13.5.0',
      fetchedAt: '2026-10-23T10:00:00.000Z',
    });
    expect(rows[0]!.items).toEqual([{ url: 'https://ex.test/i.gif', wastedBytes: 900 }]);
  });

  it('a re-run of the same url and strategy replaces its audits; the other strategy is untouched', () => {
    db.upsertPagespeedResult(A, 'mobile', metrics(), audits(audit('a1'), audit('a2')));
    db.upsertPagespeedResult(A, 'desktop', metrics(), audits(audit('d1')));
    db.upsertPagespeedResult(A, 'mobile', metrics({ fetchedAt: '2026-10-24T00:00:00.000Z' }), audits(audit('a3')));
    expect(q({ url: A, strategy: 'mobile' }).rows.map((r) => r.auditId)).toEqual(['a3']);
    expect(q({ url: A, strategy: 'mobile' }).rows[0]!.fetchedAt).toBe('2026-10-24T00:00:00.000Z');
    expect(q({ url: A, strategy: 'desktop' }).rows.map((r) => r.auditId)).toEqual(['d1']);
  });

  it('a failed re-run keeps the old audits but still overwrites the metrics row', () => {
    db.upsertPagespeedResult(A, 'mobile', metrics(), audits(audit('keep-me')));
    db.upsertPagespeedResult(A, 'mobile', metrics({ status: 'error', error: 'HTTP 500', performance: null }));
    expect(q({ url: A }).rows.map((r) => r.auditId)).toEqual(['keep-me']);
    expect(q({ url: A }).rows[0]!.fetchedAt).toBe('2026-10-23T10:00:00.000Z');
    const row = db.queryPagespeed({ limit: 10, offset: 0, search: '/a' }).rows[0]!;
    expect(row.mobile?.status).toBe('error');
    expect(row.mobile?.error).toBe('HTTP 500');
  });

  it('a successful run with zero audits kept deletes the old rows (the page is clean now)', () => {
    db.upsertPagespeedResult(A, 'mobile', metrics(), audits(audit('old')));
    db.upsertPagespeedResult(A, 'mobile', metrics(), audits());
    expect(q({ url: A }).total).toBe(0);
  });

  it('a result written without audits (old callers) leaves the stored audits alone', () => {
    db.upsertPagespeedResult(A, 'mobile', metrics(), audits(audit('old')));
    db.upsertPagespeedResult(A, 'mobile', metrics());
    expect(q({ url: A }).total).toBe(1);
  });

  it('the metrics row and its audits are written in one transaction', () => {
    const bad = audit('x');
    (bad as { items: unknown }).items = [{ toJSON: () => { throw new Error('boom'); } }];
    db.upsertPagespeedResult(A, 'mobile', metrics(), audits(audit('first')));
    expect(() => db.upsertPagespeedResult(A, 'mobile', metrics({ performance: 11 }), audits(bad))).toThrow('boom');
    expect(q({ url: A }).rows.map((r) => r.auditId)).toEqual(['first']);
    expect(db.queryPagespeed({ limit: 10, offset: 0, search: '/a' }).rows[0]!.mobile?.performance).toBe(80);
  });
});

describe('B41 R7: queryPagespeedAudits', () => {
  beforeEach(() => {
    db.upsertPagespeedResult(A, 'mobile', metrics(), audits(
      audit('none', { savingsMs: null, savingsBytes: null }),
      audit('bytes-only', { savingsMs: null, savingsBytes: 5000 }),
      audit('small', { savingsMs: 100, savingsBytes: 10 }),
      audit('big-ms', { kind: 'diagnostic', savingsMs: 900, savingsBytes: 1 }),
      audit('big-ms-more-bytes', { kind: 'opportunity', savingsMs: 900, savingsBytes: 50 }),
    ));
    db.upsertPagespeedResult(A, 'desktop', metrics(), audits(audit('small', { savingsMs: 5 })));
    db.upsertPagespeedResult(B, 'mobile', metrics(), audits(audit('small', { savingsMs: 7 })));
  });

  it('orders by savings ms desc with NULLs last, then bytes desc', () => {
    expect(q({ url: A, strategy: 'mobile' }).rows.map((r) => r.auditId)).toEqual(['big-ms-more-bytes', 'big-ms', 'small', 'bytes-only', 'none']);
  });

  it('filters by url, strategy, kind and audit id; limit and offset page the result, total counts all', () => {
    expect(q().total).toBe(7);
    expect(q({ strategy: 'desktop' }).rows.map((r) => r.url)).toEqual([A]);
    expect(q({ kind: 'diagnostic' }).rows.map((r) => r.auditId)).toEqual(['big-ms']);
    expect(q({ auditId: 'small' }).rows.map((r) => `${r.url}|${r.strategy}`)).toEqual([`${A}|mobile`, `${B}|mobile`, `${A}|desktop`]);
    const page = q({ url: A, strategy: 'mobile', limit: 2, offset: 1 });
    expect(page.total).toBe(5);
    expect(page.rows.map((r) => r.auditId)).toEqual(['big-ms', 'small']);
  });
});

describe('B41 R7: queryPagespeed gains the opportunity count and top saving per strategy', () => {
  it('counts insights and opportunities and takes the largest saving; untested strategy reads 0 / null', () => {
    db.upsertPagespeedResult(A, 'mobile', metrics(), audits(
      audit('i1', { savingsMs: 300 }), audit('o1', { kind: 'opportunity', savingsMs: 800 }), audit('g1', { kind: 'diagnostic', savingsMs: 5000 }), audit('i2'),
    ));
    const rows = db.queryPagespeed({ limit: 10, offset: 0 }).rows;
    const a = rows.find((r) => r.url === A)!;
    expect(a.mobileOpportunityCount).toBe(3);
    expect(a.mobileTopSavingsMs).toBe(800);
    expect(a.desktopOpportunityCount).toBe(0);
    expect(a.desktopTopSavingsMs).toBeNull();
    const b = rows.find((r) => r.url === B)!;
    expect(b.mobileOpportunityCount).toBe(0);
    expect(b.mobileTopSavingsMs).toBeNull();
  });

  it('keeps the rows, total and order it had before', () => {
    db.upsertPagespeedResult(A, 'mobile', metrics(), audits(audit('i1', { savingsMs: 1 }), audit('i2', { savingsMs: 2 })));
    db.upsertPagespeedResult(A, 'desktop', metrics(), audits(audit('i1', { savingsMs: 1 })));
    const r = db.queryPagespeed({ limit: 10, offset: 0 });
    expect(r.total).toBe(3);
    expect(r.rows.map((x) => x.url).sort()).toEqual([A, B, C]);
  });
});

describe('B41 R6: the table is url-keyed, so every delete path clears it', () => {
  const idOf = (url: string) => (db['db'].prepare('SELECT id FROM urls WHERE url = ?').get(url) as { id: number }).id;
  beforeEach(() => {
    for (const u of [A, B, C]) db.upsertPagespeedResult(u, 'mobile', metrics(), audits(audit('x')));
  });

  it('deleteUrl removes the audits of that url only', () => {
    db.deleteUrl(idOf(A));
    expect(q().rows.map((r) => r.url).sort()).toEqual([B, C]);
  });

  it('deleteUrls removes the audits of those urls', () => {
    db.deleteUrls([idOf(A), idOf(B)]);
    expect(q().rows.map((r) => r.url)).toEqual([C]);
  });

  it('deleteByDomain removes the audits of that host', () => {
    db.deleteByDomain('ex.test');
    expect(q().rows.map((r) => r.url)).toEqual([C]);
  });

  it('reset clears the table', () => {
    db.reset();
    expect(q().total).toBe(0);
  });
});

describe('B41 migration 126', () => {
  it('a file at version 125 with pagespeed_results rows migrates, keeps the rows and gets an empty table; twice is a no-op', () => {
    const f = path.join(dir, 'old.seoproject');
    const raw = new DatabaseSync(f);
    runMigrations(raw, 125);
    raw.exec(`INSERT INTO pagespeed_results (url, strategy, performance, status, fetched_at) VALUES ('${A}', 'mobile', 70, 'ok', 't')`);
    expect(raw.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'pagespeed_audits'`).get()).toBeUndefined();
    runMigrations(raw);
    runMigrations(raw);
    expect(raw.prepare('SELECT performance FROM pagespeed_results').get()).toMatchObject({ performance: 70 });
    expect(raw.prepare('SELECT COUNT(*) AS c FROM pagespeed_audits').get()).toMatchObject({ c: 0 });
    expect((raw.prepare('SELECT version FROM schema_version WHERE version = 126').get() as { version: number }).version).toBe(126);
    const cols = (raw.prepare('PRAGMA table_info(pagespeed_audits)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['url', 'strategy', 'audit_id', 'kind', 'title', 'score', 'display_value', 'savings_ms', 'savings_bytes', 'items_json', 'items_truncated', 'lighthouse_version', 'fetched_at']));
    raw.close();
  });
});
