import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultGa4Settings, mergeGa4Settings } from '@freecrawl/shared-types';
import { runMigrations } from './migrations.js';
import { ProjectDb } from './project-db.js';

// B37 takes migration 124 (B38 has 123; m11-render holds 121/122).
const BEFORE_B37 = 123;
const A = 'https://ex.test/a';
const B = 'https://ex.test/b';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b37-'));
  file = path.join(dir, 'p.seoproject');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function seedPages(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO urls (id, url, status_code, content_type, indexability) VALUES
      (1,'${A}',200,'text/html','indexable'),
      (2,'${B}',200,'text/html','indexable');
    INSERT INTO ga4_results (url, account_id, sessions, users, pageviews, engagement_rate, avg_session_duration, fetched_at)
    VALUES ('${A}','acc',10,8,20,0.5,30,'2026-10-22T00:00:00Z');
  `);
}

const schemaOf = (raw: DatabaseSync, table: string) =>
  (raw.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string } | undefined)?.sql;

describe('B37 migration', () => {
  it('creates ga4_custom_values and leaves every other table unchanged; twice is a no-op', () => {
    const raw = new DatabaseSync(file);
    runMigrations(raw, BEFORE_B37);
    seedPages(raw);
    const before = (
      raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
        sql: string;
      }[]
    ).filter((t) => !t.name.startsWith('sqlite_'));
    expect(before.some((t) => t.name === 'ga4_custom_values')).toBe(false);
    raw.close();

    const db = new ProjectDb(file);
    db.close();
    const raw2 = new DatabaseSync(file);
    for (const t of before) {
      // `urls` and `links` gain columns in later migrations (M17 axe, B132): the old definition stays a prefix of it.
      if (t.name === 'urls' || t.name === 'links') expect(schemaOf(raw2, t.name)!.startsWith(t.sql.slice(0, t.sql.lastIndexOf(')')).trimEnd())).toBe(true);
      else expect(schemaOf(raw2, t.name)).toBe(t.sql);
    }
    const cols = (raw2.prepare('PRAGMA table_info(ga4_custom_values)').all() as { name: string; pk: number }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(['url', 'account_id', 'field', 'value', 'sessions', 'property', 'fetched_at']);
    expect(schemaOf(raw2, 'idx_ga4_custom_account_field')).toBeDefined();
    expect((raw2.prepare('SELECT COUNT(*) AS c FROM ga4_results').get() as { c: number }).c).toBe(1);
    const v = (raw2.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }).c;
    runMigrations(raw2);
    expect((raw2.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }).c).toBe(v);
    raw2.exec('DELETE FROM schema_version WHERE version = 124');
    runMigrations(raw2); // CREATE IF NOT EXISTS: survives a repeat
    raw2.close();
  });
});

describe('B37 old settings', () => {
  it('a settings blob without the new keys reads as empty lists', () => {
    const old = { accountId: 'acc', property: 'properties/1', propertyName: 'P', days: 7 };
    const s = mergeGa4Settings(old);
    expect(s.customMetrics).toEqual([]);
    expect(s.customDimensions).toEqual([]);
    expect(s.days).toBe(7);
    expect(defaultGa4Settings().customMetrics).toEqual([]);
    expect(mergeGa4Settings(null)).toEqual(defaultGa4Settings());
  });
  it('caps the lists at 10 metrics and 5 dimensions and drops junk', () => {
    const s = mergeGa4Settings({
      customMetrics: Array.from({ length: 14 }, (_, i) => `m${i}`).concat([''] as string[]),
      customDimensions: ['a', 'a', 3, 'b', 'c', 'd', 'e', 'f'],
    });
    expect(s.customMetrics).toHaveLength(10);
    expect(s.customDimensions).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('B37 storage', () => {
  let db: ProjectDb;
  beforeEach(() => {
    const raw = new DatabaseSync(file);
    runMigrations(raw);
    seedPages(raw);
    raw.close();
    db = new ProjectDb(file);
  });
  afterEach(() => db.close());

  const put = (
    over: Partial<Parameters<ProjectDb['storeGa4CustomValues']>[0]> & {
      rows: Parameters<ProjectDb['storeGa4CustomValues']>[0]['rows'];
    },
  ) =>
    db.storeGa4CustomValues({
      accountId: 'acc',
      property: 'properties/1',
      fetchedAt: '2026-10-22T00:00:00Z',
      fields: [...new Set(over.rows.map((r) => r.field))],
      wipeAll: false,
      ...over,
    });

  it('stores a metric as text and a dimension value with its sessions; queryGa4 returns them per page', () => {
    put({
      rows: [
        { url: A, field: 'customEvent:word_count', value: '1200', sessions: null },
        { url: A, field: 'customEvent:author', value: 'Ann', sessions: 7 },
        { url: A, field: 'customEvent:author', value: 'Bob', sessions: 3 },
        { url: B, field: 'customEvent:author', value: 'Cy', sessions: 1 },
      ],
    });
    const r = db.queryGa4({
      limit: 10,
      offset: 0,
      accountId: 'acc',
      customFields: ['customEvent:word_count', 'customEvent:author'],
      customProperty: 'properties/1',
    });
    const a = r.rows.find((x) => x.url === A)!;
    expect(a.ga4!.sessions).toBe(10); // the five-metric table is unchanged
    expect(a.custom).toEqual({
      'customEvent:word_count': [{ value: '1200', sessions: null }],
      'customEvent:author': [
        { value: 'Ann', sessions: 7 },
        { value: 'Bob', sessions: 3 },
      ],
    });
    const b = r.rows.find((x) => x.url === B)!;
    expect(b.custom).toEqual({ 'customEvent:author': [{ value: 'Cy', sessions: 1 }] });
    // no fields chosen -> no custom key at all
    expect(db.queryGa4({ limit: 10, offset: 0, accountId: 'acc' }).rows[0]!.custom).toBeUndefined();
    // another property's rows are not shown
    const other = db.queryGa4({ limit: 10, offset: 0, accountId: 'acc', customFields: ['customEvent:author'], customProperty: 'properties/2' });
    expect(other.rows.every((x) => !x.custom || Object.keys(x.custom).length === 0)).toBe(true);
  });

  it('replacing a field wipes that field first; wipeAll clears the whole account in the same call', () => {
    put({ rows: [{ url: A, field: 'f1', value: 'x', sessions: 1 }, { url: A, field: 'f2', value: 'y', sessions: 1 }] });
    put({ rows: [{ url: B, field: 'f1', value: 'z', sessions: 2 }] });
    expect(db.ga4CustomFieldRowCounts('acc')).toEqual({ f1: 1, f2: 1 });
    put({ rows: [{ url: A, field: 'f3', value: 'n', sessions: 1 }], wipeAll: true });
    expect(db.ga4CustomFieldRowCounts('acc')).toEqual({ f3: 1 });
  });

  it('a field that came back with no rows still replaces the old ones', () => {
    put({ rows: [{ url: A, field: 'f1', value: 'x', sessions: 1 }] });
    put({ fields: ['f1'], rows: [] });
    expect(db.ga4CustomFieldRowCounts('acc')).toEqual({});
  });

  it('keeps other accounts apart, deletes fields no longer chosen, counts unmatched urls', () => {
    put({ rows: [{ url: A, field: 'f1', value: 'x', sessions: 1 }, { url: 'https://ex.test/a?utm=1', field: 'f1', value: 'q', sessions: 1 }] });
    db.storeGa4CustomValues({ accountId: 'other', property: 'properties/1', fetchedAt: 't', fields: ['f1'], wipeAll: false, rows: [{ url: A, field: 'f1', value: 'o', sessions: 1 }] });
    put({ rows: [{ url: A, field: 'f2', value: 'y', sessions: 1 }] });
    expect(db.ga4UnmatchedUrlCount('acc')).toBe(1);
    db.deleteGa4CustomFieldsExcept('acc', ['f2']);
    expect(db.ga4CustomFieldRowCounts('acc')).toEqual({ f2: 1 });
    expect(db.ga4CustomFieldRowCounts('other')).toEqual({ f1: 1 });
    db.wipeGa4CustomValues('acc');
    expect(db.ga4CustomFieldRowCounts('acc')).toEqual({});
    expect(db.ga4CustomFieldRowCounts('other')).toEqual({ f1: 1 });
  });

  it('the Detail view returns the page values; deleting the url and resetting the project clear them', () => {
    put({ rows: [{ url: A, field: 'f1', value: 'x', sessions: 4 }] });
    const d = db.getUrlAnalytics(A, '', 'acc', '', { property: 'properties/1', fields: ['f1'] });
    expect(d!.ga4Custom).toEqual({ f1: [{ value: 'x', sessions: 4 }] });
    db.deleteUrl(1);
    expect(db.ga4CustomFieldRowCounts('acc')).toEqual({});
    put({ rows: [{ url: B, field: 'f1', value: 'x', sessions: 1 }] });
    db.deleteByDomain('ex.test');
    expect(db.ga4CustomFieldRowCounts('acc')).toEqual({});
  });
});

describe('B37 what the tab shows comes from the stored pull metadata', () => {
  const metaWith = (db: ProjectDb, property: string, fields: { field: string; ok: boolean }[]) =>
    db.setMeta(
      'ga4FetchMeta:acc',
      JSON.stringify({
        property,
        propertyName: 'p',
        startDate: '2026-10-01',
        endDate: '2026-10-22',
        fetchedAt: 't',
        rowCount: 1,
        customFields: fields.map((f) => ({ ...f, kind: 'dimension', rows: 1 })),
      }),
    );

  it('queryGa4 and getUrlAnalytics attach only the ok fields of the last pull, for its property', () => {
    const raw = new DatabaseSync(file);
    runMigrations(raw);
    seedPages(raw);
    raw.close();
    const db = new ProjectDb(file);
    const base = { accountId: 'acc', property: 'properties/1', fetchedAt: 't', wipeAll: false };
    db.storeGa4CustomValues({ ...base, fields: ['d1'], rows: [{ url: A, field: 'd1', value: 'x', sessions: 3 }] });
    db.storeGa4CustomValues({ ...base, fields: ['d2'], rows: [{ url: A, field: 'd2', value: 'y', sessions: 2 }] });

    metaWith(db, 'properties/1', [{ field: 'd1', ok: true }, { field: 'd2', ok: false }]);
    const rowA = () => db.queryGa4({ limit: 10, offset: 0, accountId: 'acc' }).rows.find((r) => r.url === A)!;
    expect(Object.keys(rowA().custom ?? {})).toEqual(['d1']);
    expect(Object.keys(db.getUrlAnalytics(A, '', 'acc', '')?.ga4Custom ?? {})).toEqual(['d1']);

    metaWith(db, 'properties/2', [{ field: 'd1', ok: true }]); // rows belong to property 1
    expect(rowA().custom).toBeUndefined();
    db.setMeta('ga4FetchMeta:acc', '');
    expect(rowA().custom).toBeUndefined();
    db.close();
  });
});
