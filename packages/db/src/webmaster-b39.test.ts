import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebmasterBrokenLinkRow, WebmasterEventRow } from '@freecrawl/shared-types';
import { runMigrations } from './migrations.js';
import { ProjectDb } from './project-db.js';

// B39 takes migration 125 (B38 has 123, B37 has 124).
const BEFORE_B39 = 124;
const HOST = 'https:ex.test:443';
const A = 'https://ex.test/a';
const B = 'https://ex.test/b';
const C = 'https://ex.test/c';
const GONE = 'https://ex.test/gone';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b39-'));
  file = path.join(dir, 'p.seoproject');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ev = (url: string, over: Partial<WebmasterEventRow> = {}): WebmasterEventRow => ({
  url,
  title: null,
  event: 'REMOVED_FROM_SEARCH',
  reason: 'HTTP_ERROR',
  badHttpStatus: 404,
  targetUrl: null,
  eventDate: '2026-10-01T00:00:00.000Z',
  lastAccess: '2026-10-02T00:00:00.000Z',
  ...over,
});
const bl = (s: string, d: string): WebmasterBrokenLinkRow => ({
  sourceUrl: s,
  destinationUrl: d,
  discoveryDate: '2026-10-01T00:00:00.000Z',
  sourceLastAccessDate: '2026-10-02T00:00:00.000Z',
});

const schemaOf = (raw: DatabaseSync, table: string) =>
  (raw.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string } | undefined)?.sql;

describe('B39 migration', () => {
  it('creates both tables on a project from before this module and keeps every other table and row', () => {
    const raw = new DatabaseSync(file);
    runMigrations(raw, BEFORE_B39);
    raw.exec(`INSERT INTO urls (id, url, status_code, content_type, indexability) VALUES (1,'${A}',200,'text/html','indexable')`);
    const before = (
      raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
        sql: string;
      }[]
    ).filter((t) => !t.name.startsWith('sqlite_'));
    expect(before.some((t) => t.name.startsWith('webmaster_'))).toBe(false);
    raw.close();

    const db = new ProjectDb(file);
    // The tab on an old project: empty lists and no pull yet, not an error.
    expect(db.queryWebmasterExcluded({ hostId: HOST, limit: 10, offset: 0 })).toEqual({ rows: [], total: 0, meta: null });
    db.close();

    const raw2 = new DatabaseSync(file);
    for (const t of before) expect(schemaOf(raw2, t.name)).toBe(t.sql);
    const cols = (t: string) =>
      (raw2.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('webmaster_events')).toEqual([
      'host_id', 'url', 'event', 'reason', 'bad_http_status', 'target_url', 'title', 'event_date', 'last_access', 'fetched_at',
    ]);
    expect(cols('webmaster_broken_links')).toEqual([
      'host_id', 'source_url', 'destination_url', 'discovery_date', 'source_last_access_date', 'fetched_at',
    ]);
    expect(schemaOf(raw2, 'idx_webmaster_events_url')).toBeDefined();
    expect(schemaOf(raw2, 'idx_webmaster_links_destination')).toBeDefined();
    expect((raw2.prepare('SELECT COUNT(*) AS c FROM urls').get() as { c: number }).c).toBe(1);
    const v = (raw2.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }).c;
    runMigrations(raw2);
    expect((raw2.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }).c).toBe(v);
    raw2.exec('DELETE FROM schema_version WHERE version = 125');
    runMigrations(raw2); // CREATE IF NOT EXISTS: survives a repeat
    raw2.close();
  });

  it('a read-only open of a project without the tables answers with empty lists', () => {
    const raw = new DatabaseSync(file);
    runMigrations(raw, BEFORE_B39);
    raw.close();
    const db = new ProjectDb(file, { readOnly: true });
    expect(db.queryWebmasterBrokenLinks({ hostId: HOST, limit: 10, offset: 0 })).toEqual({ rows: [], total: 0, meta: null });
    db.close();
  });
});

describe('B39 storage', () => {
  let db: ProjectDb;
  beforeEach(() => {
    const raw = new DatabaseSync(file);
    runMigrations(raw);
    raw.exec(`
      INSERT INTO urls (id, url, status_code, content_type, indexability, content_kind, is_external) VALUES
        (1,'${A}',200,'text/html','indexable','html',0),
        (2,'${B}',200,'text/html','non-indexable','html',0),
        (3,'${C}',404,'text/html','indexable','html',0);
      INSERT INTO links (from_url_id, to_url, is_internal) VALUES (1,'${C}',1),(2,'${A}',1);
    `);
    raw.close();
    db = new ProjectDb(file);
  });
  afterEach(() => db.close());

  const rowsOf = (table: string) => {
    const raw = new DatabaseSync(file, { readOnly: true });
    const rows = raw.prepare(`SELECT * FROM ${table} ORDER BY 1,2,3`).all() as Record<string, unknown>[];
    raw.close();
    return rows;
  };
  const noFetched = (rows: Record<string, unknown>[]) => rows.map(({ fetched_at: _f, ...r }) => r);

  it('pulling twice against the same data leaves every row identical (r1 H1)', () => {
    const events = [ev(A), ev(B, { event: 'APPEARED_IN_SEARCH', reason: null }), ev(GONE)];
    const links = [bl(A, C), bl(B, GONE)];
    db.upsertWebmasterEvents(HOST, events, '2026-10-10T00:00:00.000Z');
    db.upsertWebmasterBrokenLinks(HOST, links, '2026-10-10T00:00:00.000Z');
    const firstEvents = noFetched(rowsOf('webmaster_events'));
    const firstLinks = noFetched(rowsOf('webmaster_broken_links'));

    const startedAt = '2026-10-11T00:00:00.000Z';
    db.upsertWebmasterEvents(HOST, events, '2026-10-11T00:00:05.000Z');
    db.upsertWebmasterBrokenLinks(HOST, links, '2026-10-11T00:00:06.000Z');
    expect(db.deleteStaleWebmasterRows(HOST, startedAt)).toEqual({ events: 0, links: 0 });

    expect(noFetched(rowsOf('webmaster_events'))).toEqual(firstEvents);
    expect(noFetched(rowsOf('webmaster_broken_links'))).toEqual(firstLinks);
    expect(rowsOf('webmaster_events')).toHaveLength(3);
    expect(rowsOf('webmaster_events').every((r) => r.fetched_at === '2026-10-11T00:00:05.000Z')).toBe(true);
  });

  it('rows not reported again are deleted, only for this host', () => {
    db.upsertWebmasterEvents(HOST, [ev(A), ev(GONE)], '2026-10-10T00:00:00.000Z');
    db.upsertWebmasterEvents('other:host:443', [ev(A)], '2026-10-10T00:00:00.000Z');
    db.upsertWebmasterBrokenLinks(HOST, [bl(A, C), bl(B, GONE)], '2026-10-10T00:00:00.000Z');
    db.upsertWebmasterEvents(HOST, [ev(A)], '2026-10-11T00:00:01.000Z');
    db.upsertWebmasterBrokenLinks(HOST, [bl(A, C)], '2026-10-11T00:00:01.000Z');
    expect(db.deleteStaleWebmasterRows(HOST, '2026-10-11T00:00:00.000Z')).toEqual({ events: 1, links: 1 });
    expect(rowsOf('webmaster_events').map((r) => `${r.host_id}|${r.url}`)).toEqual([`${HOST}|${A}`, `other:host:443|${A}`]);
  });

  it('a page that came back after a removal shows as present, and an older event never overrides a newer one', () => {
    db.upsertWebmasterEvents(HOST, [ev(A, { eventDate: '2026-10-01T00:00:00.000Z' })], '2026-10-10T00:00:00.000Z');
    expect(db.queryWebmasterExcluded({ hostId: HOST, limit: 10, offset: 0 }).rows.map((r) => r.url)).toEqual([A]);

    db.upsertWebmasterEvents(
      HOST,
      [ev(A, { event: 'APPEARED_IN_SEARCH', reason: null, badHttpStatus: null, eventDate: '2026-10-05T00:00:00.000Z' })],
      '2026-10-11T00:00:00.000Z',
    );
    expect(db.queryWebmasterExcluded({ hostId: HOST, limit: 10, offset: 0 }).rows).toEqual([]);

    // The older REMOVED event reported again by a later pull must not bring the page back to «excluded».
    db.upsertWebmasterEvents(HOST, [ev(A, { eventDate: '2026-10-01T00:00:00.000Z' })], '2026-10-12T00:00:00.000Z');
    const row = rowsOf('webmaster_events')[0]!;
    expect(row.event).toBe('APPEARED_IN_SEARCH');
    expect(row.reason).toBeNull();
    expect(row.event_date).toBe('2026-10-05T00:00:00.000Z');
    expect(row.fetched_at).toBe('2026-10-12T00:00:00.000Z');
    expect(db.deleteStaleWebmasterRows(HOST, '2026-10-12T00:00:00.000Z')).toEqual({ events: 0, links: 0 });
  });

  it('the newer of two events of one page wins whatever order they arrive in, also across time zones', () => {
    // +0300 04:00 on the 5th is 01:00Z; the Z event at 02:00Z is later in real time.
    const earlier = ev(A, { event: 'REMOVED_FROM_SEARCH', eventDate: '2026-10-05T01:00:00.000Z' });
    const later = ev(A, { event: 'APPEARED_IN_SEARCH', reason: null, eventDate: '2026-10-05T02:00:00.000Z' });
    db.upsertWebmasterEvents(HOST, [later, earlier], '2026-10-10T00:00:00.000Z');
    expect(rowsOf('webmaster_events')[0]!.event).toBe('APPEARED_IN_SEARCH');
  });

  it('the excluded view joins crawl status and indexability and has the three presets', () => {
    db.upsertWebmasterEvents(
      HOST,
      [ev(A), ev(B), ev(C), ev(GONE), ev('https://ex.test/appeared', { event: 'APPEARED_IN_SEARCH' })],
      '2026-10-10T00:00:00.000Z',
    );
    const q = (preset: 'all' | 'indexable-in-crawl' | 'not-in-crawl') =>
      db.queryWebmasterExcluded({ hostId: HOST, preset, limit: 50, offset: 0 });
    const all = q('all');
    expect(all.total).toBe(4);
    expect(all.rows.find((r) => r.url === A)).toMatchObject({
      id: 1, crawlStatusCode: 200, crawlIndexability: 'indexable', reason: 'HTTP_ERROR', badHttpStatus: 404,
    });
    expect(all.rows.find((r) => r.url === GONE)).toMatchObject({ id: null, crawlStatusCode: null, crawlIndexability: null });
    expect(q('indexable-in-crawl').rows.map((r) => r.url).sort()).toEqual([A, C].sort());
    expect(q('not-in-crawl').rows.map((r) => r.url)).toEqual([GONE]);
    expect(db.queryWebmasterExcluded({ hostId: HOST, search: 'ex.test/b', limit: 50, offset: 0 }).rows.map((r) => r.url)).toEqual([B]);
    expect(db.queryWebmasterExcluded({ hostId: HOST, limit: 2, offset: 2 })).toMatchObject({ total: 4 });
    expect(db.queryWebmasterExcluded({ hostId: 'nobody', limit: 5, offset: 0 }).total).toBe(0);
  });

  it('the broken links view shows the destination status, flags links the crawl also found, and has the presets', () => {
    // The crawl saw A -> C and C answers 404, so (A, C) is also in the crawl's broken links.
    db.upsertWebmasterBrokenLinks(HOST, [bl(A, C), bl(B, GONE), bl(B, A)], '2026-10-10T00:00:00.000Z');
    const all = db.queryWebmasterBrokenLinks({ hostId: HOST, limit: 50, offset: 0 });
    expect(all.total).toBe(3);
    const by = (s: string, d: string) => all.rows.find((r) => r.sourceUrl === s && r.destinationUrl === d)!;
    expect(by(A, C)).toMatchObject({ destinationStatusCode: 404, seenByCrawl: true });
    expect(by(B, GONE)).toMatchObject({ destinationStatusCode: null, seenByCrawl: false });
    expect(by(B, A)).toMatchObject({ destinationStatusCode: 200, seenByCrawl: false });
    const unseen = db.queryWebmasterBrokenLinks({ hostId: HOST, preset: 'not-seen-by-crawl', limit: 50, offset: 0 });
    expect(unseen.rows.map((r) => r.destinationUrl).sort()).toEqual([A, GONE].sort());
    expect(unseen.total).toBe(2);
  });

  it('the fetch meta of the host comes back with the view', () => {
    const meta = { hostName: 'ex.test', fetchedAt: 'x', eventRows: 1, brokenLinkRows: 0, truncatedAtCap: true };
    db.setMeta(`webmasterFetchMeta:${HOST}`, JSON.stringify(meta));
    expect(db.queryWebmasterExcluded({ hostId: HOST, limit: 5, offset: 0 }).meta).toEqual(meta);
  });

  it('a project reset empties both tables', () => {
    db.upsertWebmasterEvents(HOST, [ev(A)], '2026-10-10T00:00:00.000Z');
    db.upsertWebmasterBrokenLinks(HOST, [bl(A, C)], '2026-10-10T00:00:00.000Z');
    db.reset();
    expect(rowsOf('webmaster_events')).toEqual([]);
    expect(rowsOf('webmaster_broken_links')).toEqual([]);
  });

  describe('deleting URLs keeps working on a project holding Webmaster rows (r1 M1)', () => {
    const seed = () => {
      db.upsertWebmasterEvents(HOST, [ev(A), ev(B), ev(GONE)], '2026-10-10T00:00:00.000Z');
      db.upsertWebmasterBrokenLinks(HOST, [bl(A, GONE), bl(GONE, A), bl(B, C), bl('https://other.test/x', 'https://other.test/y')], '2026-10-10T00:00:00.000Z');
    };
    const left = () => rowsOf('webmaster_broken_links').map((r) => `${r.source_url}>${r.destination_url}`);

    it('deleteUrl removes the url\'s event and the broken links from and to it', () => {
      seed();
      db.deleteUrl(1);
      expect(rowsOf('webmaster_events').map((r) => r.url)).toEqual([B, GONE]);
      expect(left()).toEqual([`${B}>${C}`, 'https://other.test/x>https://other.test/y']);
    });

    it('deleteUrls removes them for every id in the list', () => {
      seed();
      db.deleteUrls([1, 2]);
      expect(rowsOf('webmaster_events').map((r) => r.url)).toEqual([GONE]);
      expect(left()).toEqual(['https://other.test/x>https://other.test/y']);
    });

    it('deleteByDomain removes events and broken links of that host and leaves other hosts', () => {
      seed();
      db.deleteByDomain('ex.test');
      expect(rowsOf('webmaster_events')).toEqual([]);
      expect(left()).toEqual(['https://other.test/x>https://other.test/y']);
    });
  });
});

describe('B39 detail panel reason', () => {
  const open = (): ProjectDb => {
    const raw = new DatabaseSync(file);
    runMigrations(raw);
    raw.exec(`INSERT INTO urls (id, url, status_code, content_type, indexability) VALUES (1,'${A}',200,'text/html','indexable')`);
    raw.close();
    return new ProjectDb(file);
  };

  it('shows why Yandex removed the page, for the chosen host', () => {
    const db = open();
    db.upsertWebmasterEvents(HOST, [ev(A, { reason: 'NOT_CANONICAL', badHttpStatus: null })], '2026-10-10T00:00:00.000Z');
    const got = db.getUrlAnalytics(A, '', '', '', undefined, HOST);
    expect(got?.webmaster).toEqual({
      reason: 'NOT_CANONICAL',
      badHttpStatus: null,
      targetUrl: null,
      eventDate: '2026-10-01T00:00:00.000Z',
    });
    expect(db.getUrlAnalytics(A, '', '', '', undefined, 'https:other.test:443')).toBeNull();
    expect(db.getUrlAnalytics(A)).toBeNull();
    db.close();
  });

  it('says nothing about a page that came back', () => {
    const db = open();
    db.upsertWebmasterEvents(HOST, [ev(A, { event: 'APPEARED_IN_SEARCH', reason: null })], '2026-10-10T00:00:00.000Z');
    expect(db.getUrlAnalytics(A, '', '', '', undefined, HOST)).toBeNull();
    db.close();
  });

  it('answers on a project opened read-only before the tables existed', () => {
    const raw = new DatabaseSync(file);
    runMigrations(raw, BEFORE_B39);
    raw.close();
    const db = new ProjectDb(file, { readOnly: true });
    expect(db.getUrlAnalytics(A, '', '', '', undefined, HOST)).toBeNull();
    db.close();
  });
});
