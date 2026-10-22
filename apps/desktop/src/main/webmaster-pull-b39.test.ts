import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeUrl, type WebmasterDeps } from '@freecrawl/core';
import { ProjectDb } from '@freecrawl/db';
import type { WebmasterRunProgress } from '@freecrawl/shared-types';
import { pullWebmaster, type WebmasterPullInput } from './webmaster-pull.js';

const TOKEN = 'y0_fake-token-for-tests';
const HOST = 'https:ex.test:443';
const realFetch = globalThis.fetch;

/** Per-file guard: only 127.0.0.1 is reachable. Passed as deps.fetch; nothing is stubbed globally. */
const guardFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(href).hostname;
  if (host !== '127.0.0.1') return Promise.reject(new Error(`guard: blocked host ${host}`));
  return realFetch(input as string, init);
}) as unknown as NonNullable<WebmasterDeps['fetch']>;

interface Item {
  [k: string]: unknown;
}
interface Logged {
  kind: 'user' | 'events' | 'links';
  offset: number;
}
type Fault = (l: Logged) => { status: number; body: unknown } | 'drop' | null;

let dir: string;
let file: string;
let db: ProjectDb;
let server: http.Server;
let baseUrl = '';
let log: Logged[] = [];
let events: Item[] = [];
let links: Item[] = [];
let fault: Fault = () => null;

const NORMALIZE = (u: string): string | null =>
  normalizeUrl(u, undefined, { stripWww: true, forceHttps: true, lowercasePath: true, trailingSlash: 'strip' });

const event = (url: string, over: Item = {}): Item => ({
  url,
  title: 't',
  event_date: '2026-10-01T03:00:00,000+0300',
  last_access: '2026-10-02T03:00:00,000+0300',
  event: 'REMOVED_FROM_SEARCH',
  excluded_url_status: 'HTTP_ERROR',
  bad_http_status: 404,
  ...over,
});
const events230 = (): Item[] => Array.from({ length: 230 }, (_, i) => event(`https://ex.test/p${i}`));
const links120 = (): Item[] =>
  Array.from({ length: 120 }, (_, i) => ({
    source_url: `https://ex.test/s${i}`,
    destination_url: `https://ex.test/d${i}`,
    discovery_date: '2026-10-01T03:00:00,000+0300',
    source_last_access_date: '2026-10-02T03:00:00,000+0300',
  }));

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b39-pull-'));
  file = path.join(dir, 'p.seoproject');
  db = new ProjectDb(file);
  log = [];
  events = events230();
  links = links120();
  fault = () => null;
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://127.0.0.1');
    const p = decodeURIComponent(u.pathname);
    const offset = Number(u.searchParams.get('offset') ?? 0);
    const limit = Number(u.searchParams.get('limit') ?? 0);
    const kind: Logged['kind'] = p.endsWith('/events/samples') ? 'events' : p.endsWith('/broken/samples') ? 'links' : 'user';
    const entry: Logged = { kind, offset };
    log.push(entry);
    const f = fault(entry);
    if (f === 'drop') return void req.socket.destroy();
    const reply = f ?? {
      status: 200,
      body:
        kind === 'user'
          ? { user_id: 7 }
          : kind === 'events'
            ? { count: events.length, samples: events.slice(offset, offset + limit) }
            : { count: links.length, links: links.slice(offset, offset + limit) },
    };
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v4`;
});
afterEach(async () => {
  db.close();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse('2026-10-10T00:00:00.000Z');
let clock = T0;
const hours = (h: number): number => h * 3_600_000;
const api = (): WebmasterDeps => ({ fetch: guardFetch, baseUrl, sleep: async () => {}, now: () => 0 });
const input = (over: Partial<WebmasterPullInput> = {}): WebmasterPullInput => ({
  token: TOKEN,
  hostId: HOST,
  hostName: 'ex.test',
  normalize: NORMALIZE,
  ...over,
});
const pull = (over: Partial<WebmasterPullInput> = {}) =>
  pullWebmaster(input(over), { db, api: api(), now: () => new Date(clock) });
beforeEach(() => {
  clock = T0;
});

const raw = <T,>(sql: string): T[] => {
  const r = new DatabaseSync(file, { readOnly: true });
  const rows = r.prepare(sql).all() as unknown as T[];
  r.close();
  return rows;
};
const count = (t: string): number => raw<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`)[0]!.c;
const runRecord = (): WebmasterRunProgress | null => {
  const v = db.getMeta(`webmasterRun:${HOST}`);
  return v ? (JSON.parse(v) as WebmasterRunProgress) : null;
};
const listLog = (kind: Logged['kind']) => log.filter((l) => l.kind === kind).map((l) => l.offset);

describe('B39 pull', () => {
  it('stores 230 events and 120 broken links, clears the progress record and writes the fetch meta', async () => {
    const res = await pull();
    expect(res.ok).toBe(true);
    expect(count('webmaster_events')).toBe(230);
    expect(count('webmaster_broken_links')).toBe(120);
    expect(runRecord()).toBeNull();
    expect(JSON.parse(db.getMeta(`webmasterFetchMeta:${HOST}`)!)).toMatchObject({
      hostName: 'ex.test', fetchedAt: new Date(T0).toISOString(), eventRows: 230, brokenLinkRows: 120, truncatedAtCap: false,
    });
    expect(listLog('events')).toEqual([0, 100, 200]);
    expect(listLog('links')).toEqual([0, 100]);
    expect(raw<{ event_date: string }>('SELECT event_date FROM webmaster_events LIMIT 1')[0]!.event_date).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });

  it('two complete pulls against the same data leave identical rows; a vanished row goes; a returned page shows as present (r1 H1)', async () => {
    await pull();
    const snap = () =>
      JSON.stringify([
        raw('SELECT host_id,url,event,reason,bad_http_status,event_date FROM webmaster_events ORDER BY url'),
        raw('SELECT host_id,source_url,destination_url,discovery_date FROM webmaster_broken_links ORDER BY 2,3'),
      ]);
    const first = snap();
    clock = T0 + hours(2);
    expect((await pull()).ok).toBe(true);
    expect(snap()).toBe(first);
    expect(count('webmaster_events')).toBe(230);
    expect(raw<{ c: number }>(`SELECT COUNT(*) AS c FROM webmaster_events WHERE fetched_at < '${new Date(clock).toISOString()}'`)[0]!.c).toBe(0);

    // p0 came back after its removal; p1 is no longer reported; one link is fixed.
    events[0] = event('https://ex.test/p0', { event: 'APPEARED_IN_SEARCH', event_date: '2026-10-05T03:00:00,000+0300' });
    events.splice(1, 1);
    links.splice(0, 1);
    clock = T0 + hours(4);
    await pull();
    expect(count('webmaster_events')).toBe(229);
    expect(raw('SELECT 1 FROM webmaster_events WHERE url = \'https://ex.test/p1\'')).toEqual([]);
    expect(count('webmaster_broken_links')).toBe(119);
    expect(db.queryWebmasterExcluded({ hostId: HOST, limit: 500, offset: 0 }).rows.some((r) => r.url === 'https://ex.test/p0')).toBe(false);
    expect(db.queryWebmasterExcluded({ hostId: HOST, limit: 500, offset: 0 }).total).toBe(228);
  });

  it('URLs are normalised with the project rewrites: the newer event of two spellings of one page wins; unreadable URLs are counted, not stored', async () => {
    events = [
      event('HTTP://WWW.Ex.com/A/', { event_date: '2026-10-01T03:00:00,000+0300' }),
      event('https://ex.com/a', { event: 'APPEARED_IN_SEARCH', event_date: '2026-10-03T03:00:00,000+0300' }),
      event('http://www.ex.com/b/'),
      event('not a url'),
    ];
    links = [];
    await pull();
    const rows = raw<{ url: string; event: string }>('SELECT url, event FROM webmaster_events ORDER BY url');
    expect(rows).toEqual([
      { url: 'https://ex.com/a', event: 'APPEARED_IN_SEARCH' },
      { url: 'https://ex.com/b', event: 'REMOVED_FROM_SEARCH' },
    ]);
    expect(JSON.parse(db.getMeta(`webmasterFetchMeta:${HOST}`)!).skippedRows).toBe(1);
  });

  it('a connection dropped after page 2 keeps pages 1-2; the next pull starts at offset 200 and drops older stale rows', async () => {
    db.upsertWebmasterEvents(HOST, [{ url: 'https://ex.test/old', title: null, event: 'REMOVED_FROM_SEARCH', reason: null, badHttpStatus: null, targetUrl: null, eventDate: null, lastAccess: null }], '2026-09-01T00:00:00.000Z');
    fault = (l) => (l.kind === 'events' && l.offset === 200 ? 'drop' : null);
    const res = await pull();
    expect(res).toMatchObject({ ok: false, errorCode: 'network' });
    expect(count('webmaster_events')).toBe(201); // 200 new + the old one, not deleted yet
    expect(runRecord()).toMatchObject({ startedAt: new Date(T0).toISOString(), eventsOffset: 200, eventsCount: 230, eventsDone: false });

    fault = () => null;
    log = [];
    clock = T0 + hours(1);
    expect((await pull()).ok).toBe(true);
    expect(listLog('events')[0]).toBe(200);
    expect(listLog('events')).toEqual([200]);
    expect(count('webmaster_events')).toBe(230);
    expect(raw('SELECT 1 FROM webmaster_events WHERE url = \'https://ex.test/old\'')).toEqual([]);
    expect(runRecord()).toBeNull();
  });

  it('a finished events phase is skipped (only verified) when the links phase is what failed', async () => {
    fault = (l) => (l.kind === 'links' && l.offset === 100 ? 'drop' : null);
    expect(await pull()).toMatchObject({ ok: false });
    expect(runRecord()).toMatchObject({ eventsDone: true, linksOffset: 100, linksCount: 120 });
    fault = () => null;
    log = [];
    clock = T0 + hours(1);
    await pull();
    expect(listLog('events')).toEqual([230]); // one verification request, no rows re-read
    expect(listLog('links')).toEqual([100]);
    expect(count('webmaster_events')).toBe(230);
  });

  it('when the list moved between runs the next pull restarts at offset 0 with a new startedAt (r1 L2, r2-L6)', async () => {
    fault = (l) => (l.kind === 'events' && l.offset === 200 ? 'drop' : null);
    await pull();
    fault = () => null;
    events = events.slice(10); // the list shifted: 220 rows now, p0..p9 are no longer reported
    log = [];
    clock = T0 + hours(1);
    expect((await pull()).ok).toBe(true);
    expect(listLog('events')).toEqual([200, 0, 100, 200]);
    // p0..p9 were stored by the first, partial run; the restart took a new startedAt, so they are stale now.
    expect(count('webmaster_events')).toBe(220);
    expect(raw('SELECT 1 FROM webmaster_events WHERE url = \'https://ex.test/p0\'')).toEqual([]);
  });

  it('a count change found in the links phase restarts the whole pull, events included', async () => {
    fault = (l) => (l.kind === 'links' && l.offset === 100 ? 'drop' : null);
    await pull();
    fault = () => null;
    links = links.slice(30);
    log = [];
    clock = T0 + hours(1);
    expect((await pull()).ok).toBe(true);
    expect(listLog('events')).toEqual([230, 0, 100, 200]);
    expect(listLog('links')).toEqual([100, 0]);
    expect(count('webmaster_broken_links')).toBe(90);
    expect(count('webmaster_events')).toBe(230);
  });

  it('a record older than 24 hours is ignored: the pull starts from 0', async () => {
    fault = (l) => (l.kind === 'events' && l.offset === 200 ? 'drop' : null);
    await pull();
    fault = () => null;
    log = [];
    clock = T0 + hours(25);
    await pull();
    expect(listLog('events')).toEqual([0, 100, 200]);
  });

  it('a record of another host is not used', async () => {
    fault = (l) => (l.kind === 'events' && l.offset === 200 ? 'drop' : null);
    await pull();
    fault = () => null;
    log = [];
    await pull({ hostId: 'https:other.test:443' });
    expect(listLog('events')).toEqual([0, 100, 200]);
  });

  it('a cancelled pull keeps what it saved and its record', async () => {
    const ac = new AbortController();
    const res = await pull({ signal: ac.signal, onProgress: (p) => p.done >= 100 && ac.abort() });
    expect(res).toMatchObject({ ok: false, cancelled: true, errorCode: 'cancelled' });
    expect(count('webmaster_events')).toBe(100);
    expect(runRecord()).toMatchObject({ eventsOffset: 100 });
  });
});

describe('B39 pull errors', () => {
  it('daily QUOTA_EXCEEDED stops at once, keeps the record and reports exceeded_until (r1 M6)', async () => {
    fault = (l) =>
      l.kind === 'events' && l.offset === 100
        ? { status: 429, body: { error_code: 'QUOTA_EXCEEDED', daily_quota: 5, exceeded_until: '2026-10-11T06:00:00,000+0300' } }
        : null;
    const res = await pull();
    expect(res).toMatchObject({ ok: false, errorCode: 'quota-exceeded', exceededUntil: '2026-10-11T03:00:00.000Z' });
    expect(log.filter((l) => l.kind === 'events')).toHaveLength(2);
    expect(count('webmaster_events')).toBe(100);
    expect(runRecord()).toMatchObject({ eventsOffset: 100, exceededUntil: '2026-10-11T03:00:00.000Z' });
  });

  it('a quota stop on the very first request still saves exceeded_until', async () => {
    fault = (l) => (l.kind === 'events' ? { status: 429, body: { error_code: 'QUOTA_EXCEEDED', exceeded_until: '2026-10-11T00:00:00,000+0000' } } : null);
    await pull();
    expect(runRecord()).toMatchObject({ eventsOffset: 0, exceededUntil: '2026-10-11T00:00:00.000Z' });
  });

  it('before exceeded_until no request is made; after it a resume continues from the saved offset even past 24 h (r2-M1)', async () => {
    // exceeded_until is 30 h after startedAt.
    fault = (l) =>
      l.kind === 'events' && l.offset === 100
        ? { status: 429, body: { error_code: 'QUOTA_EXCEEDED', exceeded_until: new Date(T0 + hours(30)).toISOString() } }
        : null;
    await pull();
    fault = () => null;

    log = [];
    clock = T0 + hours(10);
    expect(await pull()).toMatchObject({ ok: false, errorCode: 'quota-exceeded', exceededUntil: new Date(T0 + hours(30)).toISOString() });
    expect(log).toEqual([]);

    clock = T0 + hours(31); // 7 h past startedAt + 24 h, 1 h past the quota window
    expect((await pull()).ok).toBe(true);
    expect(listLog('events')[0]).toBe(100);
    expect(listLog('events')).toEqual([100, 200]);
    expect(count('webmaster_events')).toBe(230);
    expect(runRecord()).toBeNull();
  });

  it('a resume is not valid after exceeded_until + 24 h', async () => {
    fault = (l) =>
      l.kind === 'events' && l.offset === 100
        ? { status: 429, body: { error_code: 'QUOTA_EXCEEDED', exceeded_until: new Date(T0 + hours(30)).toISOString() } }
        : null;
    await pull();
    fault = () => null;
    log = [];
    clock = T0 + hours(55);
    await pull();
    expect(listLog('events')).toEqual([0, 100, 200]);
  });

  it('403 INVALID_OAUTH_TOKEN is token-rejected and nothing is written', async () => {
    fault = () => ({ status: 403, body: { error_code: 'INVALID_OAUTH_TOKEN' } });
    expect(await pull()).toMatchObject({ ok: false, errorCode: 'token-rejected' });
    expect(count('webmaster_events') + count('webmaster_broken_links')).toBe(0);
    expect(runRecord()).toBeNull();
    expect(db.getMeta(`webmasterFetchMeta:${HOST}`)).toBeNull();
  });

  it('403 ACCESS_FORBIDDEN is access-denied and names the two scopes', async () => {
    fault = (l) => (l.kind === 'events' ? { status: 403, body: { error_code: 'ACCESS_FORBIDDEN' } } : null);
    const res = await pull();
    expect(res).toMatchObject({ ok: false, errorCode: 'access-denied' });
    expect(res.error).toContain('webmaster:hostinfo');
    expect(res.error).toContain('webmaster:verify');
    expect(count('webmaster_events')).toBe(0);
  });

  it('404 HOST_NOT_VERIFIED and 403 INVALID_USER_ID are typed and not retried', async () => {
    fault = (l) => (l.kind === 'events' ? { status: 404, body: { error_code: 'HOST_NOT_VERIFIED' } } : null);
    expect(await pull()).toMatchObject({ ok: false, errorCode: 'host-not-verified' });
    expect(log.filter((l) => l.kind === 'events')).toHaveLength(1);
    fault = (l) => (l.kind === 'events' ? { status: 403, body: { error_code: 'INVALID_USER_ID' } } : null);
    expect(await pull()).toMatchObject({ ok: false, errorCode: 'invalid-user' });
  });

  it('the error text never contains the token', async () => {
    fault = () => 'drop';
    const res = await pull();
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });
});
