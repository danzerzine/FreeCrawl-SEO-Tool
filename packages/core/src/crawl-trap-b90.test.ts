import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'b90-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const baseConfig = (startUrl: string): CrawlConfig => ({
  ...DEFAULT_CRAWL_CONFIG,
  startUrl,
  maxConcurrency: 2,
  discoverSitemaps: false,
  checkExternalLinks: false,
  probeTlsCerts: false,
  probeManifestJson: false,
  probeSocialImages: false,
  probeImageSizes: false,
});

const quiet = (c: Crawler): Crawler => {
  c.on('error', () => {});
  return c;
};

describe('requeueKnown: one place drops a URL from seen', () => {
  it('seen.delete( appears only inside requeueKnown', () => {
    const src = readFileSync(new URL('./crawler.ts', import.meta.url), 'utf8');
    const lines = src.split('\n');
    const at = lines.flatMap((l, i) => (l.includes('seen.delete(') ? [i] : []));
    expect(at).toHaveLength(1);
    const start = lines.findIndex((l) => /\brequeueKnown\(/.test(l) && /^\s*(private )?requeueKnown\(/.test(l));
    expect(start).toBeGreaterThan(-1);
    expect(at[0]!).toBeGreaterThan(start);
    expect(at[0]! - start).toBeLessThan(12);
  });
});

describe('counts are the same for fresh, refresh, resume and re-spider', () => {
  let server: Server;
  let base: string;
  let requests = 0;
  let onRequest: ((n: number) => void) | null = null;

  const page = (body: string): string =>
    `<html><head><title>T ${body.length} page title long enough</title><link rel="stylesheet" href="/s.css"><script src="/a.js"></script></head><body><img src="/i.png" alt="x">${body}</body></html>`;

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests++;
      const url = req.url ?? '/';
      const path = url.split('?')[0]!;
      const html = (s: string): void => {
        res.writeHead(200, { 'content-type': 'text/html' }).end(page(s));
        onRequest?.(requests);
      };
      if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /blocked/\n');
      if (path === '/s.css') return void res.writeHead(200, { 'content-type': 'text/css' }).end('@font-face{font-family:x;src:url(/f.woff2)} body{color:#222}');
      if (path === '/a.js') return void res.writeHead(200, { 'content-type': 'application/javascript' }).end('var a=1;');
      if (path === '/f.woff2') return void res.writeHead(200, { 'content-type': 'font/woff2' }).end(Buffer.alloc(64));
      if (path === '/i.png') return void res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
      if (path === '/doc.pdf') return void res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.4 tiny');
      if (path === '/r') return void res.writeHead(301, { location: '/s1/p1' }).end();
      if (path === '/') {
        const links: string[] = ['/doc.pdf', '/r', '/blocked/x'];
        for (let s = 1; s <= 3; s++) for (let p = 1; p <= 12; p++) links.push(`/s${s}/p${p}`);
        for (let i = 0; i < 30; i++) links.push(`/shop?color=c${i % 6}&size=s${i % 5}&n=${i}`);
        return html(links.map((l) => `<a href="${l}">${l}</a>`).join(' '));
      }
      html(`<p>${url} ${'word '.repeat(60)}</p>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => void server.close());

  const watchState = (c: Crawler) => {
    const w = c.trapWatch;
    return {
      n: w.discovered,
      sizes: w.tableSizes(),
      shop: w.patternCount(`127.0.0.1:${new URL(base).port}?color,n,size`),
    };
  };
  const run = async (db: ProjectDb, opts: ConstructorParameters<typeof Crawler>[2] = {}) => {
    const c = quiet(new Crawler(baseConfig(`${base}/`), db, opts));
    await c.start();
    return c;
  };

  it('a stored page counts once however the project is walked again', async () => {
    const db = new ProjectDb(join(dir, 'a.seoproject'));
    const fresh = watchState(await run(db));
    // 1 home + pdf + redirect + 36 pages + 30 facet pages; css/js/img/font and the robots-blocked URL are not pages
    expect(fresh.n).toBe(1 + 1 + 1 + 36 + 30);
    expect(fresh.shop).toBe(30);

    const refreshed = watchState(await run(db));
    expect(refreshed).toEqual(fresh);

    const one = watchState(await run(db, { respiderSeeds: [`${base}/s1/p2`] }));
    expect(one).toEqual(fresh);
    const sel = Array.from({ length: 30 }, (_, i) => `${base}/shop?color=c${i % 6}&size=s${i % 5}&n=${i}`);
    expect(watchState(await run(db, { respiderSeeds: sel }))).toEqual(fresh);
    db.close();
  }, 60_000);

  it('stop in the middle and resume ends with the same counts, queued URLs included', async () => {
    const db = new ProjectDb(join(dir, 'b.seoproject'));
    const c1 = quiet(new Crawler(baseConfig(`${base}/`), db));
    onRequest = (n) => {
      if (n === requests && stopAt !== 0 && n >= stopAt) {
        stopAt = 0;
        void c1.saveQueueCheckpoint().then(() => c1.stop());
      }
    };
    let stopAt = requests + 12;
    await c1.start();
    onRequest = null;
    expect(db.loadUnfetchedQueueCheckpoint().length).toBeGreaterThan(10);
    const c2 = quiet(new Crawler(baseConfig(`${base}/`), db, { resumeOnly: true }));
    c2.enqueueCheckpointed(db.loadUnfetchedQueueCheckpoint());
    await c2.start();
    const resumed = watchState(c2);
    expect(resumed.n).toBe(1 + 1 + 1 + 36 + 30);
    expect(resumed.shop).toBe(30);
    db.close();
  }, 60_000);
});
