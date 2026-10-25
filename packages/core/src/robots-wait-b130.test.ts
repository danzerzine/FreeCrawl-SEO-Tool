import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { loadRobots } from './robots.js';

/*
 * Two origins on one host (two ports, so both are internal under the
 * default scope). Each robots.txt answers late or fails as a test sets it;
 * every request is logged so a test can tell what was never fetched.
 */
type RobotsMode = {
  delayMs?: number;
  fails?: number;
  resets?: number;
  hangAfterFails?: boolean;
  body: string;
};
const servers: Server[] = [];
let dir: string;
let baseA: string;
let baseB: string;
const hits: string[] = [];
const robots: Record<'A' | 'B', RobotsMode> = { A: { body: '' }, B: { body: '' } };
const robotsCalls = { A: 0, B: 0 };

function serve(name: 'A' | 'B', pages: () => Record<string, string>): Promise<string> {
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    hits.push(`${name}${url}`);
    if (url === '/robots.txt') {
      const r = robots[name];
      const call = ++robotsCalls[name];
      setTimeout(() => {
        if (call <= (r.resets ?? 0)) return void req.socket.resetAndDestroy();
        if (call <= (r.fails ?? 0)) return void res.writeHead(503).end();
        if (r.hangAfterFails) return; // never answers: the client times out
        res.writeHead(200, { 'content-type': 'text/plain' }).end(r.body);
      }, r.delayMs ?? 0);
      return;
    }
    const links = pages()[url];
    if (links === undefined) return void res.writeHead(404).end();
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(`<html><head><title>Page ${url}</title></head><body>${links}</body></html>`);
  });
  servers.push(server);
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () =>
      r(`http://127.0.0.1:${(server.address() as { port: number }).port}`),
    ),
  );
}

const a = (href: string) => `<a href="${href}">${href}</a>`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b130-'));
  baseA = await serve('A', () => ({
    '/': a('/private') + a('/ok') + a(`${baseB}/secret`),
    '/ok': '',
  }));
  baseB = await serve('B', () => ({ '/secret': '', '/open': '' }));
});
afterAll(() => {
  for (const s of servers) s.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  hits.length = 0;
  robotsCalls.A = robotsCalls.B = 0;
  robots.A = { body: '' };
  robots.B = { body: '' };
});

function makeCrawler(name: string): { db: ProjectDb; c: Crawler; warnings: string[] } {
  const db = new ProjectDb(join(dir, `${name}.seoproject`));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: `${baseA}/`,
      maxUrls: 50,
      maxConcurrency: 2,
      respectRobotsTxt: true,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
    },
    db,
    { robotsRetryDelaysMs: [20, 20] },
  );
  const warnings: string[] = [];
  c.on('warn', (m: string) => warnings.push(m));
  c.on('error', () => {});
  return { db, c, warnings };
}

async function crawl(name: string): Promise<{ db: ProjectDb; warnings: string[] }> {
  const { db, c, warnings } = makeCrawler(name);
  await c.start();
  return { db, warnings };
}

const blocked = (db: ProjectDb) =>
  db
    .queryUrls({ limit: 50, offset: 0, category: 'indexability:blocked-robots' })
    .rows.map((r) => r.url)
    .sort();

it('a slow robots.txt is read before the first page; a second origin waits for its own (B130)', async () => {
  robots.A = { delayMs: 1500, body: 'User-agent: *\nDisallow: /private\n' };
  robots.B = { delayMs: 1000, body: 'User-agent: *\nDisallow: /secret\n' };
  const { db } = await crawl('slow');
  expect(hits).not.toContain('A/private');
  expect(hits).not.toContain('B/secret');
  expect(hits).toContain('A/ok');
  expect(blocked(db)).toEqual([`${baseA}/private`, `${baseB}/secret`].sort());
  expect(robotsCalls).toEqual({ A: 1, B: 1 });
  db.close();
}, 30_000);

it('robots.txt 503 is retried: the third answer applies (B130)', async () => {
  robots.A = { fails: 2, body: 'User-agent: *\nDisallow: /private\n' };
  const { db } = await crawl('retry');
  expect(robotsCalls.A).toBe(3);
  expect(hits).not.toContain('A/private');
  expect(blocked(db)).toContain(`${baseA}/private`);
  db.close();
}, 30_000);

it('robots.txt that keeps failing: the crawl goes on and the warning counts the attempts (B130)', async () => {
  robots.A = { fails: 99, body: '' };
  const { db, warnings } = await crawl('broken');
  expect(robotsCalls.A).toBe(3);
  expect(hits).toContain('A/private');
  expect(warnings.some((w) => w.includes('robots.txt') && w.includes('3 attempts'))).toBe(true);
  db.close();
}, 30_000);

it('a 503 and then a timeout ends with the warning, without retrying the timeout (B130)', async () => {
  robots.A = { fails: 1, hangAfterFails: true, body: '' };
  const { db, warnings } = await crawl('timeout');
  expect(robotsCalls.A).toBe(2);
  expect(warnings.some((w) => w.includes('robots.txt') && w.includes('2 attempts'))).toBe(true);
  db.close();
}, 30_000);

it('robots.txt answered by a dropped connection is retried like a 503 (B130)', async () => {
  robots.A = { resets: 2, body: 'User-agent: *\nDisallow: /private\n' };
  const { db } = await crawl('reset');
  expect(robotsCalls.A).toBe(3);
  expect(hits).not.toContain('A/private');
  expect(blocked(db)).toContain(`${baseA}/private`);
  db.close();
}, 30_000);

it('a refused connection is retried too, and the notice names it (B130)', async () => {
  const gone = createServer();
  await new Promise<void>((r) => gone.listen(0, '127.0.0.1', r));
  const port = (gone.address() as { port: number }).port;
  await new Promise<void>((r) => gone.close(() => r()));
  const notices: string[] = [];
  const started = Date.now();
  await loadRobots(`http://127.0.0.1:${port}`, 'FreeCrawl', (m) => notices.push(m), [60, 60]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('ECONNREFUSED');
  expect(notices[0]).toContain('all 3 attempts');
});

it("Stop while a fetch waits for another origin's robots.txt frees it at once (B130)", async () => {
  robots.B = { delayMs: 8000, body: '' };
  const { db, c } = makeCrawler('stop');
  const done = c.start();
  const until = Date.now() + 4000;
  while (!hits.includes('B/robots.txt') && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  expect(hits).toContain('B/robots.txt');
  // The link is queued as soon as the page is parsed; give its fetch time to start waiting.
  await new Promise((r) => setTimeout(r, 300));
  const stoppedAt = Date.now();
  c.stop();
  await done;
  expect(Date.now() - stoppedAt).toBeLessThan(2500);
  expect(hits).not.toContain('B/secret');
  db.close();
}, 30_000);
