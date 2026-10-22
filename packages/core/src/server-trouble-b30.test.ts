import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

/*
 * A site of pages /p/N, each linking to three more. Per test, some pages
 * always answer 500, never answer, or every page slows down after a while.
 */
let server: Server;
let dir: string;
let base: string;
let pageHits: number[] = [];
let failing: (n: number) => boolean = () => false;
let hanging: (n: number) => boolean = () => false;
let delayMs: (hit: number) => number = () => 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b30-'));
  server = createServer((req, res) => {
    const m = /^\/p\/(\d+)$/.exec(req.url ?? '');
    if (!m && req.url !== '/') return void res.writeHead(404).end();
    const n = m ? Number(m[1]) : 0;
    pageHits.push(Date.now());
    if (hanging(n)) return;
    if (failing(n)) return void res.writeHead(500).end();
    const body =
      `<html><head><title>p${n}</title></head><body>` +
      [1, 2, 3].map((k) => `<a href="/p/${n * 3 + k}">x</a>`).join('') +
      '</body></html>';
    setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end(body), delayMs(pageHits.length));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  pageHits = [];
  failing = () => false;
  hanging = () => false;
  delayMs = () => 0;
});

let n = 0;
interface Run {
  /** Adaptive speed messages about server trouble or slow answers. */
  events: { at: number; message: string }[];
  /** Page requests in the two seconds after the first such message. */
  hitsAfterFirst: number;
  /** From the stop call until the crawl returned. */
  stopLagMs: number;
}

/** Crawls; stops two seconds after the first trouble message, if any. */
async function crawl(over: Partial<CrawlConfig>): Promise<Run> {
  const db = new ProjectDb(join(dir, `p${++n}.seoproject`));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: `${base}/`,
      maxUrls: 60,
      maxConcurrency: 4,
      maxRps: 10,
      retryInitialDelayMs: 50,
      respectRobotsTxt: false,
      discoverSitemaps: false,
      checkImages: false,
      checkCss: false,
      checkJs: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      ...over,
    },
    db,
  );
  const events: Run['events'] = [];
  let hitsAfterFirst = 0;
  let stoppedAt = 0;
  c.on('info', (m) => {
    const message = String(m);
    if (!/^Adaptive speed: (server|answers)/.test(message)) return;
    events.push({ at: Date.now(), message });
    if (events.length > 1) return;
    const at = pageHits.length;
    setTimeout(() => {
      hitsAfterFirst = pageHits.length - at;
      stoppedAt = Date.now();
      c.stop();
    }, 2000);
  });
  await c.start();
  db.close();
  return { events, hitsAfterFirst, stopLagMs: stoppedAt ? Date.now() - stoppedAt : 0 };
}

describe('adaptive speed on server trouble (B30)', () => {
  it('every third page failing: a pause and a cut with adaptive speed on, nothing with it off', async () => {
    failing = (k) => k > 0 && k % 3 === 0;
    const on = await crawl({ adaptiveSpeed: true });
    expect(on.events[0]?.message).toMatch(/^Adaptive speed: server errors/);
    // The pause: requests already in flight may land, no new ones start.
    expect(on.hitsAfterFirst).toBeLessThanOrEqual(4 * 3);
    // Stop does not wait out the 30 s pause.
    expect(on.stopLagMs).toBeLessThan(3000);
    const off = await crawl({ adaptiveSpeed: false, maxUrls: 40 });
    expect(off.events).toEqual([]);
  }, 60_000);

  it('one page failing on every attempt, or 5 % of them, slows nothing', async () => {
    failing = (k) => k === 7;
    expect((await crawl({ adaptiveSpeed: true, maxUrls: 40 })).events).toEqual([]);
    failing = (k) => k > 0 && k % 20 === 0;
    expect((await crawl({ adaptiveSpeed: true, maxUrls: 80, maxRps: 40 })).events).toEqual([]);
  }, 60_000);

  it('timeouts count as trouble', async () => {
    hanging = (k) => k > 0 && k % 3 === 0;
    const run = await crawl({ adaptiveSpeed: true, requestTimeoutMs: 300, retryAttempts: 0 });
    expect(run.events[0]?.message).toMatch(/^Adaptive speed: server errors/);
  }, 60_000);

  it('answers slowing from 50 ms to 600 ms: a cut', async () => {
    delayMs = (hit) => (hit > 30 ? 600 : 50);
    const run = await crawl({ adaptiveSpeed: true, maxUrls: 120, maxRps: 40 });
    expect(run.events[0]?.message).toMatch(/^Adaptive speed: answers slowing/);
    expect(run.hitsAfterFirst).toBeLessThanOrEqual(4);
  }, 60_000);
});

describe('night rate (B30)', () => {
  const hour = new Date().getHours();
  const gaps = () => pageHits.slice(1, 6).map((t, i) => t - pageHits[i]!);

  it('inside the window requests are spaced at nightMaxRps', async () => {
    await crawl({ maxRps: 50, nightMaxRps: 2, nightFromHour: hour, nightToHour: (hour + 1) % 24, maxUrls: 8 });
    expect(gaps().length).toBe(5);
    for (const g of gaps()) expect(g).toBeGreaterThanOrEqual(450);
  }, 60_000);

  it('outside it, at maxRps', async () => {
    await crawl({
      maxRps: 50,
      nightMaxRps: 2,
      nightFromHour: (hour + 1) % 24,
      nightToHour: (hour + 2) % 24,
      maxUrls: 8,
    });
    expect(Math.max(...gaps())).toBeLessThan(400);
  }, 60_000);
});
