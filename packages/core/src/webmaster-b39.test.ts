import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebmasterBrokenLinkRow, WebmasterEventRow } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WebmasterError,
  fetchBrokenLinks,
  fetchSearchEvents,
  getUserId,
  listHosts,
  webmasterDate,
  type WebmasterDeps,
} from './webmaster.js';

const TOKEN = 'y0_fake-token-for-tests';
const HOST = 'https:ex.test:443';
const realFetch = globalThis.fetch;

/** Per-file guard: only 127.0.0.1 is reachable, so a test that forgets its baseUrl cannot reach Yandex. */
const guardFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(href).hostname;
  if (host !== '127.0.0.1') return Promise.reject(new Error(`guard: blocked host ${host}`));
  return realFetch(input as string, init);
}) as unknown as NonNullable<WebmasterDeps['fetch']>;

interface Logged {
  path: string;
  offset: number;
  limit: number;
  auth: string | undefined;
}
type Reply = { status: number; body: unknown } | 'drop';

let server: http.Server;
let baseUrl = '';
let log: Logged[] = [];
let handler: (req: Logged) => Reply = () => ({ status: 200, body: {} });
let sleeps: number[] = [];

const deps = (): WebmasterDeps => ({
  fetch: guardFetch,
  baseUrl,
  sleep: async (ms) => {
    sleeps.push(ms);
  },
  now: () => 0,
});

beforeEach(async () => {
  log = [];
  sleeps = [];
  handler = () => ({ status: 200, body: {} });
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://127.0.0.1');
    const entry: Logged = {
      path: decodeURIComponent(u.pathname),
      offset: Number(u.searchParams.get('offset') ?? 0),
      limit: Number(u.searchParams.get('limit') ?? 0),
      auth: req.headers.authorization,
    };
    log.push(entry);
    const r = handler(entry);
    if (r === 'drop') {
      req.socket.destroy();
      return;
    }
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v4`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const event = (i: number) => ({
  url: `https://ex.test/p${i}`,
  title: `t${i}`,
  event_date: '2016-01-01T00:00:00,000+0300',
  last_access: '2016-01-02T00:00:00,000+0300',
  event: 'REMOVED_FROM_SEARCH',
  excluded_url_status: 'HTTP_ERROR',
  bad_http_status: 404,
  target_url: null,
});
const link = (i: number) => ({
  source_url: `https://ex.test/s${i}`,
  destination_url: `https://ex.test/d${i}`,
  discovery_date: '2016-01-01T00:00:00,000+0300',
  source_last_access_date: '2016-01-02T00:00:00,000+0300',
});

/** A server holding `total` items of one list, paged by offset/limit like Yandex. */
function lists(events: number, links: number): (r: Logged) => Reply {
  return (r) => {
    const isEvents = r.path.endsWith('/search-urls/events/samples');
    const total = isEvents ? events : links;
    const n = Math.max(0, Math.min(r.limit, total - r.offset));
    const items = Array.from({ length: n }, (_, k) => (isEvents ? event(r.offset + k) : link(r.offset + k)));
    return { status: 200, body: isEvents ? { count: total, samples: items } : { count: total, links: items } };
  };
}

const collect = async <T>(
  run: (onPage: (rows: T[], next: number, count: number) => void) => Promise<unknown>,
): Promise<{ rows: T[]; pages: number[] }> => {
  const rows: T[] = [];
  const pages: number[] = [];
  await run((r, next) => {
    rows.push(...r);
    pages.push(next);
  });
  return { rows, pages };
};

describe('B39 Webmaster client paging', () => {
  it('230 events come back in order over three pages of 100 with the right offsets', async () => {
    handler = lists(230, 0);
    const { rows, pages } = await collect<WebmasterEventRow>((onPage) =>
      fetchSearchEvents(TOKEN, 7, HOST, { onPage }, deps()),
    );
    expect(rows.map((r) => r.url)).toEqual(Array.from({ length: 230 }, (_, i) => `https://ex.test/p${i}`));
    expect(log.map((l) => [l.offset, l.limit])).toEqual([
      [0, 100],
      [100, 100],
      [200, 100],
    ]);
    expect(pages).toEqual([100, 200, 230]);
    expect(log[0]!.path).toBe(`/v4/user/7/hosts/${HOST}/search-urls/events/samples`);
    expect(log[0]!.auth).toBe(`OAuth ${TOKEN}`);
    expect(rows[0]).toMatchObject({
      event: 'REMOVED_FROM_SEARCH',
      reason: 'HTTP_ERROR',
      badHttpStatus: 404,
      eventDate: '2015-12-31T21:00:00.000Z',
    });
  });

  it('120 broken links come back over two pages, with no indicator filter', async () => {
    handler = lists(0, 120);
    const { rows } = await collect<WebmasterBrokenLinkRow>((onPage) => fetchBrokenLinks(TOKEN, 7, HOST, { onPage }, deps()));
    expect(rows).toHaveLength(120);
    expect(rows[119]).toMatchObject({
      sourceUrl: 'https://ex.test/s119',
      destinationUrl: 'https://ex.test/d119',
      discoveryDate: '2015-12-31T21:00:00.000Z',
    });
    expect(log.map((l) => l.offset)).toEqual([0, 100]);
    expect(log[0]!.path.endsWith('/links/internal/broken/samples')).toBe(true);
  });

  it('stops at 50 000 rows and says it was cut', async () => {
    handler = lists(60_000, 0);
    let stored = 0;
    const res = await fetchSearchEvents(TOKEN, 7, HOST, { onPage: (r) => void (stored += r.length) }, deps());
    expect(stored).toBe(50_000);
    expect(res.truncatedAtCap).toBe(true);
    expect(log).toHaveLength(500);
  });

  it('a list that ends exactly on a page boundary stops without an extra empty page', async () => {
    handler = lists(200, 0);
    const res = await fetchSearchEvents(TOKEN, 7, HOST, { onPage: () => {} }, deps());
    expect(log.map((l) => l.offset)).toEqual([0, 100]);
    expect(res).toMatchObject({ count: 200, truncatedAtCap: false });
  });

  it('keeps at most 4 requests a second: a pause of 250 ms between requests', async () => {
    handler = lists(230, 0);
    const clock = { t: 1_000 };
    await fetchSearchEvents(
      TOKEN,
      7,
      HOST,
      { onPage: () => {} },
      {
        ...deps(),
        now: () => clock.t,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock.t += ms;
        },
      },
    );
    expect(sleeps).toEqual([250, 250]);
  });
});

describe('B39 Webmaster client user and hosts', () => {
  it('reads the user id and lists the hosts', async () => {
    handler = (r) =>
      r.path === '/v4/user'
        ? { status: 200, body: { user_id: 4242 } }
        : {
            status: 200,
            body: {
              hosts: [
                { host_id: 'https:ex.test:443', ascii_host_url: 'https://ex.test', unicode_host_url: 'https://ex.test', verified: true },
                { host_id: 'http:old.test:80', ascii_host_url: 'http://old.test', unicode_host_url: 'http://old.test', verified: false },
              ],
            },
          };
    const id = await getUserId(TOKEN, deps());
    const hosts = await listHosts(TOKEN, id, deps());
    expect(id).toBe(4242);
    expect(log[1]!.path).toBe('/v4/user/4242/hosts');
    expect(hosts).toEqual([
      { hostId: 'https:ex.test:443', hostName: 'ex.test', verified: true },
      { hostId: 'http:old.test:80', hostName: 'old.test', verified: false },
    ]);
  });
});

describe('B39 Webmaster client retry and errors', () => {
  it('429 TOO_MANY_REQUESTS once and 500 once are retried with backoff and succeed', async () => {
    const inner = lists(5, 0);
    let n = 0;
    handler = (r) => {
      n++;
      if (n === 1) return { status: 429, body: { error_code: 'TOO_MANY_REQUESTS_ERROR', error_message: 'slow' } };
      if (n === 2) return { status: 500, body: {} };
      return inner(r);
    };
    const { rows } = await collect<WebmasterEventRow>((onPage) => fetchSearchEvents(TOKEN, 7, HOST, { onPage }, deps()));
    expect(rows).toHaveLength(5);
    expect(log).toHaveLength(3);
    expect(sleeps.filter((s) => s >= 1000)).toHaveLength(2);
  });

  it('a dropped connection is retried and then reported as network', async () => {
    handler = () => 'drop';
    const err = await fetchSearchEvents(TOKEN, 7, HOST, { onPage: () => {} }, deps()).catch((e) => e);
    expect(err).toBeInstanceOf(WebmasterError);
    expect(err.code).toBe('network');
    expect(log.length).toBeGreaterThan(1);
    expect(err.message).not.toContain(TOKEN);
  });

  it.each([
    [403, { error_code: 'INVALID_USER_ID', available_user_id: 9 }, 'invalid-user'],
    [404, { error_code: 'HOST_NOT_VERIFIED', error_message: 'x' }, 'host-not-verified'],
    [401, { error_code: 'X' }, 'token-rejected'],
    [403, { error_code: 'INVALID_OAUTH_TOKEN' }, 'token-rejected'],
  ] as const)('HTTP %i %j is %s and is not retried', async (status, body, code) => {
    handler = () => ({ status, body });
    const err = await fetchSearchEvents(TOKEN, 7, HOST, { onPage: () => {} }, deps()).catch((e) => e);
    expect(err).toBeInstanceOf(WebmasterError);
    expect(err.code).toBe(code);
    expect(log).toHaveLength(1);
  });

  it('403 ACCESS_FORBIDDEN is access-denied and names both scopes', async () => {
    handler = () => ({ status: 403, body: { error_code: 'ACCESS_FORBIDDEN' } });
    const err = await fetchBrokenLinks(TOKEN, 7, HOST, { onPage: () => {} }, deps()).catch((e) => e);
    expect(err.code).toBe('access-denied');
    expect(err.message).toContain('webmaster:hostinfo');
    expect(err.message).toContain('webmaster:verify');
    expect(log).toHaveLength(1);
  });

  it('daily 429 QUOTA_EXCEEDED stops at once (one request) and carries exceeded_until in UTC', async () => {
    handler = () => ({
      status: 429,
      body: { error_code: 'QUOTA_EXCEEDED', daily_quota: 1000, exceeded_until: '2016-01-02T00:00:00,000+0300' },
    });
    const err = await fetchSearchEvents(TOKEN, 7, HOST, { onPage: () => {} }, deps()).catch((e) => e);
    expect(err).toBeInstanceOf(WebmasterError);
    expect(err.code).toBe('quota-exceeded');
    expect(err.exceededUntil).toBe('2016-01-01T21:00:00.000Z');
    expect(log).toHaveLength(1);
    expect(sleeps.filter((s) => s >= 1000)).toHaveLength(0);
  });

  it('a cancelled signal stops with code cancelled', async () => {
    handler = lists(230, 0);
    const ac = new AbortController();
    const err = await fetchSearchEvents(
      TOKEN,
      7,
      HOST,
      { onPage: () => ac.abort(), signal: ac.signal },
      deps(),
    ).catch((e) => e);
    expect(err.code).toBe('cancelled');
    expect(log).toHaveLength(1);
  });
});

describe('B39 Webmaster client resume', () => {
  it('startOffset 200 requests offset 200 first', async () => {
    handler = lists(230, 0);
    const { rows } = await collect<WebmasterEventRow>((onPage) =>
      fetchSearchEvents(TOKEN, 7, HOST, { onPage, startOffset: 200, expectedCount: 230 }, deps()),
    );
    expect(log[0]!.offset).toBe(200);
    expect(rows).toHaveLength(30);
  });

  it('a changed count restarts at offset 0 and tells the caller', async () => {
    handler = lists(250, 0);
    let restarts = 0;
    const { rows } = await collect<WebmasterEventRow>((onPage) =>
      fetchSearchEvents(
        TOKEN,
        7,
        HOST,
        { onPage, startOffset: 200, expectedCount: 230, onRestart: () => void restarts++ },
        deps(),
      ),
    );
    expect(restarts).toBe(1);
    expect(log.map((l) => l.offset)).toEqual([200, 0, 100, 200]);
    expect(rows).toHaveLength(250);
  });

  it('a finished list (startOffset = count) is only verified, no rows are fetched', async () => {
    handler = lists(230, 0);
    const res = await fetchSearchEvents(
      TOKEN,
      7,
      HOST,
      { onPage: () => {}, startOffset: 230, expectedCount: 230 },
      deps(),
    );
    expect(log).toHaveLength(1);
    expect(res.count).toBe(230);
  });
});

describe('B39 Yandex dates', () => {
  it('parses the comma and the +0300 offset itself (Date.parse gives NaN on it)', () => {
    expect(Date.parse('2016-01-01T00:00:00,000+0300')).toBeNaN();
    expect(webmasterDate('2016-01-01T00:00:00,000+0300')).toBe('2015-12-31T21:00:00.000Z');
    expect(webmasterDate('2016-01-01T00:00:00.500+03:00')).toBe('2015-12-31T21:00:00.500Z');
    expect(webmasterDate('2015-12-31T21:00:00Z')).toBe('2015-12-31T21:00:00.000Z');
    expect(webmasterDate('2015-12-31T21:00:00,000-0500')).toBe('2016-01-01T02:00:00.000Z');
  });
  it('a +0300 date compares correctly against a Z one as ISO strings', () => {
    const a = webmasterDate('2016-01-01T01:00:00,000+0300')!; // 2015-12-31T22:00Z
    const b = webmasterDate('2015-12-31T23:00:00Z')!;
    expect(a < b).toBe(true);
    expect('2016-01-01T01:00:00,000+0300' < '2015-12-31T23:00:00Z').toBe(false); // the raw strings would lie
  });
  it('garbage and empty values are null', () => {
    expect(webmasterDate('yesterday')).toBeNull();
    expect(webmasterDate(null)).toBeNull();
    expect(webmasterDate('')).toBeNull();
  });
});

describe('B39 test guard', () => {
  it('rejects Yandex and Google hosts', async () => {
    await expect(guardFetch('https://api.webmaster.yandex.net/v4/user')).rejects.toThrow(/guard/);
    await expect(guardFetch('https://analyticsdata.googleapis.com/x')).rejects.toThrow(/guard/);
  });
});
