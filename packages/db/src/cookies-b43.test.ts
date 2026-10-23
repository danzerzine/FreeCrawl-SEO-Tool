import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';
import { ProjectDb } from './project-db.js';

let dir: string;
const opened: ProjectDb[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b43db-'));
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const open = (name: string): ProjectDb => {
  const db = new ProjectDb(path.join(dir, `${name}.seoproject`));
  opened.push(db);
  return db;
};
const put = (db: ProjectDb, url: string, over: Record<string, unknown> = {}): number =>
  db.upsertUrl({ url, depth: 0, statusCode: 200, indexability: 'indexable', contentKind: 'html', ...over });

const SEVEN = [
  ['cookies_json', 'TEXT'],
  ['cookies_total', 'INTEGER'],
  ['cookies_truncated', 'INTEGER'],
  ['css_bytes', 'INTEGER'],
  ['css_unused_bytes', 'INTEGER'],
  ['js_bytes', 'INTEGER'],
  ['js_unused_bytes', 'INTEGER'],
];
const sevenOf = (db: DatabaseSync): [string, string][] => {
  const cols = db.prepare('PRAGMA table_info(urls)').all() as { name: string; type: string }[];
  return SEVEN.map(([n]) => cols.find((c) => c.name === n)).filter(Boolean).map((c) => [c!.name, c!.type]);
};

describe('B43+B44 migration 129', () => {
  it('adds all seven columns in one step; old rows stay NULL; a second run changes nothing', () => {
    const old = new DatabaseSync(path.join(dir, 'old.seoproject'));
    runMigrations(old, 128);
    old.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1, 'https://ex.test/a', 0, 'html', 200)`);
    expect(sevenOf(old)).toEqual([]);
    runMigrations(old);
    expect(sevenOf(old)).toEqual(SEVEN);
    expect(old.prepare('SELECT version FROM schema_version WHERE version = 129').get()).toBeDefined();
    expect(
      old.prepare('SELECT cookies_json, cookies_total, cookies_truncated, css_bytes, css_unused_bytes, js_bytes, js_unused_bytes FROM urls').all(),
    ).toEqual([
      { cookies_json: null, cookies_total: null, cookies_truncated: null, css_bytes: null, css_unused_bytes: null, js_bytes: null, js_unused_bytes: null },
    ]);
    runMigrations(old);
    expect(old.prepare('SELECT COUNT(*) AS c FROM schema_version WHERE version = 129').get()).toEqual({ c: 1 });
    expect(sevenOf(old)).toEqual(SEVEN);
    old.close();
  });

  it('a project that already has some of the columns upgrades without error', () => {
    const old = new DatabaseSync(path.join(dir, 'half.seoproject'));
    runMigrations(old, 128);
    old.exec('ALTER TABLE urls ADD COLUMN cookies_total INTEGER');
    runMigrations(old);
    expect(sevenOf(old)).toEqual(SEVEN);
    old.close();
  });

  it('an old project (v128) opened through ProjectDb gets the columns and keeps its rows', () => {
    const file = path.join(dir, 'v128.seoproject');
    const raw = new DatabaseSync(file);
    runMigrations(raw, 128);
    raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability) VALUES (1, 'https://ex.com/', 0, 'html', 200, 'indexable')`);
    raw.close();
    const db = new ProjectDb(file);
    opened.push(db);
    const row = db.getUrlById(1)!;
    expect([row.cookiesTotal, row.cookiesTruncated, row.cookiesJson]).toEqual([null, null, null]);
    expect([...db.iterateCookies()]).toEqual([]);
  });
});

const LIST = JSON.stringify([
  { n: 'sid', d: 'ex.com', p: '/', s: 1, h: 1, ss: 'Lax', e: -1, by: 'header' },
  { n: 'ga', d: 'ex.com', p: '/', s: 0, h: 0, ss: '', e: 1900000000, by: 'script' },
]);

describe('B43 stored cookie columns', () => {
  it('store, read back, and tell "recorded none" (0, []) from "not recorded" (NULL)', () => {
    const db = open('a');
    const some = put(db, 'https://ex.com/some', { cookiesJson: LIST, cookiesTotal: 2, cookiesTruncated: 0 });
    put(db, 'https://ex.com/none', { cookiesJson: '[]', cookiesTotal: 0, cookiesTruncated: 0 });
    const unrec = put(db, 'https://ex.com/unrecorded');
    const r = db.getUrlById(some)!;
    expect([r.cookiesTotal, r.cookiesTruncated, r.cookiesJson]).toEqual([2, 0, LIST]);
    const none = db.getUrlById(db.getUrlIdByUrl('https://ex.com/none')!)!;
    expect([none.cookiesTotal, none.cookiesTruncated, none.cookiesJson]).toEqual([0, 0, '[]']);
    const u = db.getUrlById(unrec)!;
    expect([u.cookiesTotal, u.cookiesTruncated, u.cookiesJson]).toEqual([null, null, null]);
  });

  it('a refresh with the option off overwrites the three columns with NULL', () => {
    const db = open('b');
    put(db, 'https://ex.com/p', { cookiesJson: LIST, cookiesTotal: 2, cookiesTruncated: 0 });
    put(db, 'https://ex.com/p');
    const row = db.getUrlById(db.getUrlIdByUrl('https://ex.com/p')!)!;
    expect([row.cookiesTotal, row.cookiesTruncated, row.cookiesJson]).toEqual([null, null, null]);
  });
});

describe('B43 iterateCookies', () => {
  it('one row per cookie, pages in url_id order, cookies in list order, page totals repeated', () => {
    const db = open('c');
    // Insert in an order that differs from the URL text order.
    put(db, 'https://ex.com/zzz', { cookiesJson: LIST, cookiesTotal: 5, cookiesTruncated: 1 });
    put(db, 'https://ex.com/aaa', {
      cookiesJson: JSON.stringify([{ n: 'x', d: 'ads.test', p: '/t', s: null, h: 0, ss: null, e: null, by: 'script' }]),
      cookiesTotal: 1,
      cookiesTruncated: 0,
    });
    put(db, 'https://ex.com/none', { cookiesJson: '[]', cookiesTotal: 0, cookiesTruncated: 0 });
    put(db, 'https://ex.com/unrecorded');
    const rows = [...db.iterateCookies()];
    expect(rows.map((r) => [r.url, r.name])).toEqual([
      ['https://ex.com/zzz', 'sid'],
      ['https://ex.com/zzz', 'ga'],
      ['https://ex.com/aaa', 'x'],
    ]);
    expect(rows[0]).toEqual({
      urlId: expect.any(Number), url: 'https://ex.com/zzz', name: 'sid', domain: 'ex.com', path: '/',
      secure: true, httpOnly: true, sameSite: 'Lax', expires: -1, setBy: 'header', pageCookiesTotal: 5, pageCookiesTruncated: true,
    });
    expect(rows[2]).toMatchObject({ secure: null, sameSite: null, expires: null, domain: 'ads.test', setBy: 'script', pageCookiesTruncated: false });
  });

  it('is keyed on url_id: pages in batches of any size give the same rows, and the SQL has no OFFSET', () => {
    const db = open('d');
    for (let i = 0; i < 7; i++) {
      put(db, `https://ex.com/p${i}`, { cookiesJson: LIST, cookiesTotal: 2, cookiesTruncated: 0 });
    }
    const all = [...db.iterateCookies()];
    expect(all).toHaveLength(14);
    expect([...db.iterateCookies(2)]).toEqual(all);
    expect([...db.iterateCookies(1)]).toEqual(all);
    const sql: string[] = [];
    const inner = (db as unknown as { db: { prepare: (s: string) => unknown } }).db;
    const orig = inner.prepare.bind(inner);
    inner.prepare = (s: string) => {
      sql.push(s);
      return orig(s);
    };
    [...db.iterateCookies(3)];
    inner.prepare = orig;
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.join('\n')).not.toMatch(/OFFSET/i);
    expect(sql.join('\n')).toMatch(/json_each/);
  });

  it('a malformed stored JSON is skipped, never thrown', () => {
    const db = open('e');
    put(db, 'https://ex.com/bad', { cookiesJson: '{not json', cookiesTotal: 1, cookiesTruncated: 0 });
    put(db, 'https://ex.com/ok', { cookiesJson: LIST, cookiesTotal: 2, cookiesTruncated: 0 });
    expect([...db.iterateCookies()].map((r) => r.url)).toEqual(['https://ex.com/ok', 'https://ex.com/ok']);
  });
});
