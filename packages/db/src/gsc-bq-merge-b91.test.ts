import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b91db-'));
  db = new ProjectDb(path.join(dir, 'p.seoproject'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const pull = (url: string, clicks: number, impressions: number, pos0: number) => ({
  url, clicks, impressions, ctr: clicks / impressions, position: pos0 + 1,
});

describe('mergeGscResultsPart (B91)', () => {
  it('overlapping URLs: clicks and impressions add, position is the impression-weighted one-based mean, ctr is recomputed', () => {
    // queryGsc joins crawled pages only, so read the table directly
    const raw = () => (db as unknown as { db: { prepare(s: string): { get(...a: unknown[]): any } } }).db // eslint-disable-line @typescript-eslint/no-explicit-any
      .prepare("SELECT * FROM gsc_results WHERE url = ? AND account_id = 'bq'");
    db.mergeGscResultsPart('bq', [pull('u', 10, 100, 2), pull('v', 1, 10, 0)], 't1', () => ({}));
    db.mergeGscResultsPart('bq', [pull('u', 30, 300, 6)], 't2', (n) => ({ 'gscFetchMeta:bq': JSON.stringify({ rowCount: n }) }));
    const u = raw().get('u');
    expect(u.clicks).toBe(40);
    expect(u.impressions).toBe(400);
    expect(u.ctr).toBeCloseTo(0.1, 12);
    // (p1-1)*i1 + (p2-1)*i2 over the total, plus one: (2*100 + 6*300) / 400 + 1
    expect(u.position).toBeCloseTo((2 * 100 + 6 * 300) / 400 + 1, 12);
    expect(raw().get('v').impressions).toBe(10);
    expect(JSON.parse(db.getMeta('gscFetchMeta:bq')!)).toEqual({ rowCount: 2 });
  });

  it('a URL with impressions 0 stays at ctr 0 and position 0, and a later part with impressions takes over', () => {
    db.mergeGscResultsPart('bq', [{ url: 'z', clicks: 2, impressions: 0, ctr: 0, position: 0 }], 't', () => ({}));
    db.mergeGscResultsPart('bq', [pull('z', 3, 30, 4)], 't', () => ({}));
    const z = (db as unknown as { db: { prepare(s: string): { get(...a: unknown[]): any } } }).db.prepare("SELECT * FROM gsc_results WHERE url='z' AND account_id='bq'").get(); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(z.clicks).toBe(5);
    expect(z.impressions).toBe(30);
    expect(z.position).toBeCloseTo(5, 12);
    expect(z.ctr).toBeCloseTo(5 / 30, 12);
  });

  it('inserts in chunks and is one transaction: a failing meta callback leaves nothing behind', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => pull(`u${i}`, 1, 10, 1));
    expect(() =>
      db.mergeGscResultsPart('bq', rows, 't', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.mergeGscResultsPart('bq', rows, 't', () => ({}))).toBe(1000);
    expect(db.mergeGscResultsPart('bq', rows, 't', () => ({}))).toBe(1000);
  });

  it('deleteGscResults removes only the one account and the named meta keys', () => {
    db.replaceGscResults([pull('a', 1, 10, 1)], 't', 'google-acc');
    db.mergeGscResultsPart('bq', [pull('a', 5, 50, 1)], 't', () => ({ 'gscFetchMeta:bq': '{}', gscBqRun: '{}' }));
    db.setMeta('gscFetchMeta:google-acc', '{"x":1}');
    db.deleteGscResults('bq', ['gscFetchMeta:bq', 'gscBqRun']);
    const rows = (db as unknown as { db: { prepare(s: string): { all(): any[] } } }).db.prepare('SELECT account_id FROM gsc_results').all(); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(rows.map((r) => r.account_id)).toEqual(['google-acc']);
    expect(db.getMeta('gscBqRun')).toBeNull();
    expect(db.getMeta('gscFetchMeta:bq')).toBeNull();
    expect(db.getMeta('gscFetchMeta:google-acc')).toBe('{"x":1}');
  });
});
