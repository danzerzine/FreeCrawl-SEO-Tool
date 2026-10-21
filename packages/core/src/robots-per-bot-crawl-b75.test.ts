import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

let server: Server;
let dir: string;
let base: string;
const page = (head: string, body = ''): string => `<html><head><title>Page title long enough</title>${head}</head><body>${body}</body></html>`;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b75-crawl-'));
  server = createServer((req, res) => {
    const pages: Record<string, string> = {
      '/': page('', '<a href="/bing">b</a><a href="/google">g</a><a href="/conflict">c</a><a href="/yandex">y</a>'),
      '/bing': page('<meta name="bingbot" content="noindex, nofollow">', '<a href="/behind-bing">x</a>'),
      '/behind-bing': page(''),
      '/google': page('<meta name="googlebot" content="noindex">'),
      '/conflict': page('<meta name="bingbot" content="noindex"><link rel="canonical" href="/">'),
      '/yandex': page('<meta name="yandex" content="noindex">'),
    };
    const body = pages[req.url ?? ''];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(db: ProjectDb, p: string) {
  const id = db.getUrlIdByUrl(base + p);
  return id === null ? null : db.getUrlById(id);
}

async function crawl(name: string, userAgent?: string): Promise<ProjectDb> {
  const db = new ProjectDb(join(dir, `${name}.seoproject`));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      ...(userAgent ? { userAgent } : {}),
      startUrl: base,
      maxConcurrency: 2,
      respectRobotsTxt: false,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
    },
    db,
  );
  c.on('error', () => {});
  await c.start();
  return db;
}

it('a default crawl applies only robots and googlebot metas; other engines’ noindex is listed (B75)', async () => {
  const db = await crawl('g');
  const ix = (p: string) => row(db, p)?.indexability;
  expect(ix('bing')).toBe('indexable');
  expect(ix('behind-bing')).toBe('indexable'); // bingbot nofollow did not stop the link
  expect(ix('google')).toBe('non-indexable:noindex');
  expect(ix('yandex')).toBe('indexable');
  const issues = db.getOverviewCounts().issues;
  expect(issues.noindexOtherBot).toBe(3); // bing, conflict, yandex
  expect(issues.noindexCanonicalConflict).toBe(0);
  expect(row(db, 'bing')?.metaNoindexBots).toBe('bingbot');
  db.close();
}, 30_000);

it('a crawl as YandexBot applies the yandex meta and not googlebot’s (B75)', async () => {
  const db = await crawl('y', 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)');
  const ix = (p: string) => row(db, p)?.indexability;
  expect(ix('yandex')).toBe('non-indexable:noindex');
  expect(ix('google')).toBe('indexable');
  db.close();
}, 30_000);
