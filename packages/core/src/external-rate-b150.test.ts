import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as realSleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

/*
 * B150: external-link checks go no faster than the crawl rate per foreign
 * host. The own site is 127.0.0.1; foreign hosts are `localhost` (F1) and
 * 127.0.0.2 (F2): other hostnames, and a private start host lets the probe
 * through the SSRF guard. Every foreign handler records its arrivals.
 */
interface Hit {
  method: string;
  path: string;
  at: number;
}
interface Foreign {
  server: Server;
  port: number;
  hits: Hit[];
  /** HEAD answer for the host; GET always answers 200. */
  headStatus: number;
  /** The host as written in a URL. */
  host: string;
}

let dir: string;
let n = 0;
const closers: Server[] = [];

afterEach(() => vi.useRealTimers());

/** A second foreign host: 127.0.0.2, else [::1]; undefined where neither binds. */
async function foreign2(): Promise<Foreign | undefined> {
  for (const bind of ['127.0.0.2', '::1']) {
    try {
      return await foreign(bind);
    } catch {
      /* try the next address */
    }
  }
  return undefined;
}

async function foreign(host: string, headStatus = 200): Promise<Foreign> {
  const hits: Hit[] = [];
  const f = { hits, headStatus, host: host.includes(':') ? `[${host}]` : host } as Foreign;
  f.server = createServer((req, res) => {
    hits.push({ method: req.method ?? '', path: req.url ?? '', at: Date.now() });
    res
      .writeHead(req.method === 'HEAD' ? f.headStatus : 200, { 'content-type': 'text/html' })
      .end('ok');
  });
  await new Promise<void>((r) => f.server.listen(0, host, r));
  f.port = (f.server.address() as { port: number }).port;
  closers.push(f.server);
  return f;
}

/** Own site whose home page links `links` (a function of the own base URL). */
async function site(
  links: (base: string) => string[],
  extra?: (path: string, base: string) => string | undefined,
) {
  let base = '';
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    const special = extra?.(url, base);
    if (special !== undefined) {
      res.writeHead(200, { 'content-type': 'text/html' }).end(special);
      return;
    }
    if (url !== '/') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      `<html><head><title>Home page title long enough</title></head><body>` +
        links(base)
          .map((h) => `<a href="${h}">l</a>`)
          .join('') +
        `</body></html>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(server);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  return base;
}

interface Run {
  file: string;
  rows: Map<string, { status: number | null; text: string | null; ms: number | null }>;
}

/** `during` gets the crawler before it starts; its promise is awaited after the crawl ends. */
async function crawl(
  startUrl: string,
  over: Partial<CrawlConfig> = {},
  during?: (c: Crawler) => Promise<void> | void,
): Promise<Run> {
  const file = join(dir, `p${n++}.seoproject`);
  const db = new ProjectDb(file);
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl,
      maxConcurrency: 8,
      maxRps: 4,
      discoverSitemaps: false,
      checkExternalLinks: true,
      checkImages: false,
      checkCss: false,
      checkJs: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      requestTimeoutMs: 5_000,
      ...over,
    },
    db,
  );
  c.on('error', () => {});
  const side = during?.(c);
  await c.start();
  await side;
  db.close();
  const raw = new DatabaseSync(file);
  const rows = new Map<string, { status: number | null; text: string | null; ms: number | null }>();
  for (const r of raw
    .prepare('SELECT url, status_code AS s, status_text AS t, response_time_ms AS m FROM urls')
    .all() as { url: string; s: number | null; t: string | null; m: number | null }[]) {
    rows.set(r.url, { status: r.s, text: r.t, ms: r.m });
  }
  raw.close();
  return { rows, file };
}

const links = (f: Foreign, host: string, count: number, from = 0): string[] =>
  Array.from({ length: count }, (_, i) => `http://${host}:${f.port}/l${from + i}`);

/** Largest number of arrivals inside any window of `ms`. */
function maxInWindow(times: number[], ms: number): number {
  const t = [...times].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < t.length; i++) {
    while (t[i]! - t[j]! >= ms) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}
const span = (times: number[]): number => Math.max(...times) - Math.min(...times);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'b150-'));
});
afterAll(() => {
  for (const s of closers) s.close();
  rmSync(dir, { recursive: true, force: true });
});

// T1
it('checks of 12 links to one foreign host arrive no faster than maxRps and the wait stays out of the stored time', async () => {
  const f1 = await foreign('localhost');
  const start = await site(() => links(f1, 'localhost', 12));
  const { rows } = await crawl(start, { maxRps: 4 });
  const times = f1.hits.map((h) => h.at);
  expect(times).toHaveLength(12);
  // (N-2) gaps of 250 ms at least: deterministic, red when all land at once.
  expect(span(times)).toBeGreaterThanOrEqual((12 - 2) * 250);
  expect(maxInWindow(times, 1000)).toBeLessThanOrEqual(4 + 2);
  for (const h of f1.hits)
    expect(rows.get(`http://localhost:${f1.port}${h.path}`)?.status).toBe(200);
  const last = [...f1.hits].sort((a, b) => a.at - b.at).at(-1)!;
  // The last link waited about 2.75 s for its slot; the stored time is the request only.
  expect(rows.get(`http://localhost:${f1.port}${last.path}`)?.ms).toBeLessThan(2_000);
}, 60_000);

// T2
it('a HEAD 405 followed by a GET: both requests obey the same pace', async () => {
  const f1 = await foreign('localhost', 405);
  const start = await site(() => links(f1, 'localhost', 6));
  const { rows } = await crawl(start, { maxRps: 4 });
  const times = f1.hits.map((h) => h.at);
  expect(f1.hits.filter((h) => h.method === 'HEAD')).toHaveLength(6);
  expect(f1.hits.filter((h) => h.method === 'GET')).toHaveLength(6);
  expect(span(times)).toBeGreaterThanOrEqual((12 - 2) * 250);
  expect(maxInWindow(times, 1000)).toBeLessThanOrEqual(4 + 2);
  for (const h of f1.hits)
    expect(rows.get(`http://localhost:${f1.port}${h.path}`)?.status).toBe(200);
}, 60_000);

// T3
it('two foreign hosts are paced separately and run side by side', async (ctx) => {
  const f1 = await foreign('localhost');
  const f2 = await foreign2();
  if (!f2) return ctx.skip();
  const start = await site(() => [...links(f1, 'localhost', 6), ...links(f2, f2.host, 6)]);
  await crawl(start, { maxRps: 4 });
  const t1 = f1.hits.map((h) => h.at);
  const t2 = f2.hits.map((h) => h.at);
  expect(t1).toHaveLength(6);
  expect(t2).toHaveLength(6);
  for (const t of [t1, t2]) expect(span(t)).toBeGreaterThanOrEqual((6 - 2) * 250);
  // Ranges overlap: the hosts did not take turns.
  expect(Math.min(Math.max(...t1), Math.max(...t2))).toBeGreaterThan(
    Math.max(Math.min(...t1), Math.min(...t2)),
  );
}, 60_000);

// T4
it('maxRps 0 leaves foreign checks unpaced', async () => {
  const f1 = await foreign('localhost');
  const start = await site(() => links(f1, 'localhost', 12));
  await crawl(start, { maxRps: 0 });
  expect(f1.hits).toHaveLength(12);
  // Paced it would take at least 2.5 s; unpaced about 0.1 s.
  expect(span(f1.hits.map((h) => h.at))).toBeLessThan(2_000);
}, 60_000);

// T6
it('a long queue for one host does not hold the others back', async (ctx) => {
  const f1 = await foreign('localhost');
  const f2 = await foreign2();
  if (!f2) return ctx.skip();
  const start = await site(() => [...links(f1, 'localhost', 40), ...links(f2, f2.host, 4)]);
  const { rows } = await crawl(start, { maxRps: 4 });
  const t1 = f1.hits.map((h) => h.at);
  const first = Math.min(...t1);
  expect(f2.hits).toHaveLength(4);
  // With the entry guard F2 starts after about 2.5 s; without it after about 8 s.
  for (const h of f2.hits) expect(h.at - first).toBeLessThanOrEqual(5_500);
  expect(span(t1)).toBeGreaterThanOrEqual((40 - 2) * 250);
  expect(f1.hits).toHaveLength(40);
  for (const f of [f1, f2]) {
    for (const h of f.hits)
      expect(rows.get(`http://${f.host}:${f.port}${h.path}`)?.status).toBe(200);
  }
}, 90_000);

interface Gates {
  acquireRateSlot: () => Promise<void>;
  bookExternalSlot: (host: string) => number;
  extNextAt: Map<string, number>;
}
const gates = (c: Crawler): Gates => c as unknown as Gates;

async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await realSleep(10);
}

const ampPages = (count: number, amp: (i: number) => string) => (path: string, base: string) => {
  const head = (extra: string) =>
    `<html><head><title>Page title long enough here</title>${extra}</head><body>`;
  if (path === '/') {
    return (
      head('') +
      Array.from({ length: count }, (_, i) => `<a href="${base}p${i}">p</a>`).join('') +
      '</body></html>'
    );
  }
  const m = /^\/p(\d+)$/.exec(path);
  if (m) return head(`<link rel="amphtml" href="${amp(Number(m[1]))}">`) + '</body></html>';
  return undefined;
};

// T5
it('a foreign AMP target is paced by its host and takes no global slot, an in-scope one takes one', async () => {
  const amp = { foreign: false, inScope: false };
  const f1 = await foreign('localhost');
  let ownBase = '';
  const start = await site(
    () => [],
    (path, base) => {
      ownBase = base;
      return ampPages(8, (i) =>
        amp.foreign ? `http://localhost:${f1.port}/a${i}` : amp.inScope ? `${base}amp${i}` : '',
      )(path, base);
    },
  );
  const cfg = { maxRps: 4, storeAmp: true, crawlAmp: false, checkExternalLinks: false };
  const count = async (): Promise<number> => {
    let calls = 0;
    await crawl(start, cfg, (c) => {
      const g = gates(c);
      const orig = g.acquireRateSlot.bind(c);
      g.acquireRateSlot = () => {
        calls++;
        return orig();
      };
    });
    return calls;
  };
  const base = await count();
  amp.foreign = true;
  const withForeign = await count();
  const times = f1.hits.map((h) => h.at);
  expect(times).toHaveLength(8);
  expect(span(times)).toBeGreaterThanOrEqual((8 - 2) * 250);
  expect(withForeign).toBe(base);
  amp.foreign = false;
  amp.inScope = true;
  expect(await count()).toBe(base + 8);
  expect(ownBase).not.toBe('');
}, 90_000);

// T7
it('stop during rate waits ends the crawl fast and stores no false rows', async () => {
  const f1 = await foreign('localhost');
  const start = await site(() => links(f1, 'localhost', 10));
  let stoppedAt = 0;
  let hitsAtStop = 0;
  const t0 = Date.now();
  const { rows } = await crawl(start, { maxRps: 0.5 }, async (c) => {
    await until(() => f1.hits.length >= 1);
    // Let the other probes reach their waits.
    await realSleep(500);
    hitsAtStop = f1.hits.length;
    stoppedAt = Date.now();
    c.stop();
  });
  // Unpaced, all 10 probes would be through by now: the waits really existed.
  expect(hitsAtStop).toBeLessThan(10);
  expect(stoppedAt).toBeGreaterThan(t0);
  expect(Date.now() - stoppedAt).toBeLessThan(4_000);
  for (const [url, r] of rows) {
    if (url.startsWith(`http://localhost:${f1.port}/`))
      expect(r.status === null && r.text !== null).toBe(false);
  }
}, 60_000);

// T8
it('pause holds the probes that wait at the gate until resume', async () => {
  const f1 = await foreign('localhost');
  const start = await site(() => links(f1, 'localhost', 12));
  let pausedAt = 0;
  const { rows } = await crawl(start, { maxRps: 4 }, async (c) => {
    await until(() => f1.hits.length >= 1);
    c.pause();
    pausedAt = Date.now();
    await realSleep(2_000);
    // A request already on its way when pause() came may land; nothing after that.
    expect(f1.hits.filter((h) => h.at > pausedAt + 500)).toHaveLength(0);
    c.resume();
  });
  expect(pausedAt).toBeGreaterThan(0);
  expect(f1.hits.length).toBeGreaterThanOrEqual(12);
  // Most links were still waiting at pause(): they went out after resume, not before.
  expect(f1.hits.filter((x) => x.at > pausedAt + 2_000).length).toBeGreaterThan(0);
  for (const h of f1.hits)
    expect(rows.get(`http://localhost:${f1.port}${h.path}`)?.status).toBe(200);
}, 60_000);

// T9
it('the night rate paces foreign checks inside the window and not outside it', async () => {
  const h = new Date().getHours();
  const inside = {
    maxRps: 0,
    nightMaxRps: 4,
    nightFromHour: (h + 23) % 24,
    nightToHour: (h + 2) % 24,
  };
  const outside = {
    maxRps: 0,
    nightMaxRps: 4,
    nightFromHour: (h + 2) % 24,
    nightToHour: (h + 4) % 24,
  };
  const f1 = await foreign('localhost');
  const start = await site(() => links(f1, 'localhost', 12));
  await crawl(start, inside);
  expect(span(f1.hits.map((x) => x.at))).toBeGreaterThanOrEqual((12 - 2) * 250);
  const f2 = await foreign('localhost');
  const start2 = await site(() => links(f2, 'localhost', 12));
  await crawl(start2, outside);
  expect(f2.hits).toHaveLength(12);
  expect(span(f2.hits.map((x) => x.at))).toBeLessThan(2_000);
}, 60_000);

// T11
it('an out-of-scope page of the start host goes through the global gate, not a foreign clock', async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    hits.push(`${req.method} ${url}`);
    if (url === '/sub/') {
      return void res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<html><head><title>Sub page title long enough</title></head><body><a href="/sub/go">go</a></body></html>',
        );
    }
    if (url === '/sub/go') return void res.writeHead(302, { location: '/other/page' }).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(server);
  const start = `http://127.0.0.1:${(server.address() as { port: number }).port}/sub/`;
  const stubGateCalls: string[] = [];
  let booked = 0;
  await crawl(start, { scope: 'subfolder', maxRps: 20 }, (c) => {
    const g = gates(c);
    const orig = g.acquireRateSlot.bind(c);
    g.acquireRateSlot = () => {
      if ((new Error().stack ?? '').includes('attempt')) stubGateCalls.push('attempt');
      return orig();
    };
    const book = g.bookExternalSlot.bind(c);
    g.bookExternalSlot = (host) => {
      booked++;
      return book(host);
    };
  });
  expect(hits.some((x) => x.endsWith('/other/page'))).toBe(true);
  expect(stubGateCalls.length).toBeGreaterThanOrEqual(1);
  expect(booked).toBe(0);
}, 60_000);

// T10
it('a rate wait inside the chain never counts against requestTimeoutMs or the stored time', async () => {
  const f1 = await foreign('localhost', 405);
  const start = await site(() => []);
  const db = new ProjectDb(join(dir, `fake${n++}.seoproject`));
  try {
    const c = new Crawler(
      { ...DEFAULT_CRAWL_CONFIG, startUrl: start, requestTimeoutMs: 5_000, maxRps: 4 },
      db,
    );
    let booked = false;
    // The GET after HEAD 405 books its slot inside attempt(); a minute away.
    gates(c).bookExternalSlot = () => {
      booked = true;
      return 60_000;
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const chain = (
      c as unknown as {
        requestStatus: (
          u: string,
          o: { prebooked: boolean },
        ) => Promise<{ res?: { status: number }; responseTimeMs: number }>;
      }
    ).requestStatus(`http://localhost:${f1.port}/x`, { prebooked: true });
    await until(() => booked, 10_000);
    expect(booked).toBe(true);
    // The wait is a fake-clock minute: far past the 5 s timeout.
    await vi.advanceTimersByTimeAsync(60_000);
    const out = await chain;
    expect(out.res?.status).toBe(200);
    expect(out.responseTimeMs).toBeLessThan(1_000);
    expect(f1.hits.map((h) => h.method)).toEqual(['HEAD', 'GET']);
  } finally {
    vi.useRealTimers();
    db.close();
  }
}, 30_000);

// P3 (code review): Stop while a GET waits for its slot inside the chain.
it('stop while a GET waits for its host slot ends the crawl fast and writes no row', async () => {
  const f1 = await foreign('localhost', 405);
  const start = await site(() => links(f1, 'localhost', 3));
  let stoppedAt = 0;
  const { rows } = await crawl(start, { maxRps: 0.5 }, async (c) => {
    await until(() => f1.hits.length >= 1);
    await realSleep(600);
    stoppedAt = Date.now();
    c.stop();
  });
  // The GET of the first link waits several seconds for its slot; without the
  // cut the crawl would run on for about 4 s and more after Stop.
  expect(Date.now() - stoppedAt).toBeLessThan(2_500);
  expect(f1.hits.filter((h) => h.method === 'GET')).toHaveLength(0);
  for (const [url, r] of rows) {
    if (url.startsWith(`http://localhost:${f1.port}/`))
      expect(r.status === null && r.text !== null).toBe(false);
  }
}, 60_000);

it('stop while an AMP probe waits for its host slot stores no target row', async () => {
  const f1 = await foreign('localhost', 405);
  const start = await site(
    () => [],
    ampPages(3, (i) => `http://localhost:${f1.port}/a${i}`),
  );
  let stoppedAt = 0;
  const { file } = await crawl(
    start,
    { maxRps: 0.5, storeAmp: true, crawlAmp: false, checkExternalLinks: false },
    async (c) => {
      await until(() => f1.hits.length >= 1);
      await realSleep(600);
      stoppedAt = Date.now();
      c.stop();
    },
  );
  // No timing bound here: the pages of the own site still sit in their own gate, which Stop does not cut.
  expect(stoppedAt).toBeGreaterThan(0);
  expect(f1.hits.filter((h) => h.method === 'GET')).toHaveLength(0);
  const raw = new DatabaseSync(file);
  const stored = raw.prepare('SELECT COUNT(*) AS c FROM amp_targets').get() as { c: number };
  raw.close();
  expect(stored.c).toBe(0);
}, 60_000);
