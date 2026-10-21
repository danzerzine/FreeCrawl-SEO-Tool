import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { Crawler } from '../crawler.js';
import { buildCrawlSnapshot, listMetrics, metricValue } from './snapshot.js';

let server: Server;
let dir: string;
let base: string;
let aboutStatus = 200;
let slow = false;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b88a-'));
  server = createServer((req, res) => {
    if (req.url === '/robots.txt' || req.url?.includes('sitemap')) {
      res.writeHead(404).end();
      return;
    }
    const page = (title: string) =>
      `<html><head><title>${title} page title long enough</title></head><body>` +
      `<a href="/about">about</a><a href="/contact">contact</a></body></html>`;
    if (req.url === '/about') {
      res.writeHead(aboutStatus, { 'content-type': 'text/html' }).end(page('About'));
      return;
    }
    const send = () => res.writeHead(200, { 'content-type': 'text/html' }).end(page('Home'));
    if (slow) setTimeout(send, 3_000);
    else send();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function crawlerFor(db: ProjectDb, startUrl = base, extra: Partial<CrawlConfig> = {}): Crawler {
  return new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl,
      maxConcurrency: 2,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      ...extra,
    },
    db,
  );
}

async function crawl(db: ProjectDb, startUrl = base, extra: Partial<CrawlConfig> = {}): Promise<void> {
  const c = crawlerFor(db, startUrl, extra);
  c.on('error', () => {});
  await c.start();
}

it('each finished crawl appends a run whose snapshot reads per-status counts', async () => {
  const db = new ProjectDb(join(dir, 'twice.seoproject'));
  try {
    aboutStatus = 200;
    await crawl(db);
    aboutStatus = 404;
    await crawl(db);
    const runs = db.listCrawlRuns(base);
    expect(runs).toHaveLength(2);
    expect(metricValue(runs[0]!.snapshot, 'status.404')).toBe(0);
    expect(metricValue(runs[1]!.snapshot, 'status.404')).toBe(1);
    expect(metricValue(runs[1]!.snapshot, 'status.4xx')).toBe(1);
    expect(runs[1]).toMatchObject({ startUrl: base, mode: 'spider' });
    expect(runs[1]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(runs[1]!.finishedAt)).not.toBeNaN();
  } finally {
    db.close();
  }
}, 60_000);

it('a stopped crawl leaves no run behind', async () => {
  const db = new ProjectDb(join(dir, 'stopped.seoproject'));
  try {
    slow = true;
    const c = crawlerFor(db);
    c.on('error', () => {});
    const running = c.start();
    await new Promise((r) => setTimeout(r, 500));
    c.stop();
    await running;
    expect(db.listCrawlRuns(base)).toHaveLength(0);
  } finally {
    slow = false;
    db.close();
  }
}, 60_000);

it('history survives Clear and a crawl of another start URL', async () => {
  const file = join(dir, 'clear.seoproject');
  let db = new ProjectDb(file);
  try {
    aboutStatus = 200;
    await crawl(db);
    db.reset();
    await crawl(db);
    await crawl(db, `${base}about`);
    db.close();
    db = new ProjectDb(file);
    expect(db.listCrawlRuns(base)).toHaveLength(2);
    expect(db.listCrawlRuns(`${base}about`)).toHaveLength(1);
    const latest = db.listCrawlRuns(base, 1);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.id).toBe(db.listCrawlRuns(base)[1]!.id);
  } finally {
    db.close();
  }
}, 60_000);

it('a disabled check reads as not computed, an enabled one as its count', async () => {
  const db = new ProjectDb(join(dir, 'disabled.seoproject'));
  try {
    aboutStatus = 200;
    // First crawl of a site: the crawl config is the only place the
    // silenced list lives (the fresh-start wipe empties project meta).
    await crawl(db, base, { disabledIssues: ['issues:meta-missing'] });
    // Re-crawl with the list mirrored into the project, as the desktop does.
    db.setDisabledIssues(['issues:h1-missing']);
    await crawl(db);
    const [first, second] = db.listCrawlRuns(base);
    expect(metricValue(first!.snapshot, 'issues:meta-missing')).toBeNull();
    expect(metricValue(first!.snapshot, 'issues:h1-missing')).toBeGreaterThan(0);
    expect(metricValue(second!.snapshot, 'issues:h1-missing')).toBeNull();
    expect(metricValue(second!.snapshot, 'issues:meta-missing')).toBeGreaterThan(0);
    expect(buildCrawlSnapshot(db).disabledChecks).toEqual(['issues:h1-missing']);
  } finally {
    db.close();
  }
}, 60_000);

it('an unknown metric throws and names the valid ones', () => {
  const db = new ProjectDb(join(dir, 'empty.seoproject'));
  try {
    const snap = buildCrawlSnapshot(db);
    expect(() => metricValue(snap, 'status.40x')).toThrow(/Unknown metric: status\.40x\..*indexable.*status\.<code>.*issues:title-missing/);
    expect(listMetrics()).toEqual(expect.arrayContaining(['urls.total', 'status.5xx', 'response-time.avg-ms', 'issues:h1-missing']));
    expect(metricValue(snap, 'status.503')).toBe(0);
  } finally {
    db.close();
  }
});

it('the snapshot is built through dbCall (the desktop writer worker), never on the crawler thread', async () => {
  const file = join(dir, 'worker.seoproject');
  const db = new ProjectDb(file);
  const worker = new ProjectDb(file); // stands in for the writer worker's own connection
  try {
    aboutStatus = 200;
    const calls: string[] = [];
    const onCrawlerThread = { counts: 0 };
    const getOverviewCounts = db.getOverviewCounts.bind(db);
    db.getOverviewCounts = (() => {
      onCrawlerThread.counts++;
      return getOverviewCounts();
    }) as typeof db.getOverviewCounts;
    const c = new Crawler(
      {
        ...DEFAULT_CRAWL_CONFIG,
        startUrl: base,
        maxConcurrency: 2,
        discoverSitemaps: false,
        checkExternalLinks: false,
        probeTlsCerts: false,
        probeManifestJson: false,
        probeSocialImages: false,
        probeImageSizes: false,
        disabledIssues: ['issues:h1-missing'],
      },
      db,
      {
        dbCall: <T>(method: string, args: unknown[]) => {
          calls.push(method);
          const fn = (worker as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!;
          return Promise.resolve(fn.apply(worker, args) as T);
        },
      },
    );
    c.on('error', () => {});
    await c.start();
    expect(calls).toContain('recordCrawlRun');
    expect(onCrawlerThread.counts).toBe(0);
    const runs = db.listCrawlRuns(base);
    expect(runs).toHaveLength(1);
    expect(metricValue(runs[0]!.snapshot, 'status.200')).toBeGreaterThan(0);
    expect(runs[0]!.snapshot.disabledChecks).toContain('issues:h1-missing');
  } finally {
    worker.close();
    db.close();
  }
}, 60_000);
