import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { datasetRows } from './dataset-export.js';
import { fetchSitemaps, validateFetchedSitemaps } from './sitemap.js';

/*
 * /sitemap_index.xml lists /big.xml (50 001 URLs, over the protocol limit)
 * and then /small.xml. /deep1.xml → /deep2.xml → /deep3.xml → /deep4.xml
 * nests one level past the depth limit. /bomb.xml.gz inflates past the
 * reader's cap.
 */
const urlset = (paths: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
    .map((p) => `<url><loc>${base}${p}</loc></url>`)
    .join('')}</urlset>`;
const index = (paths: string[]) =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
    .map((p) => `<sitemap><loc>${base}${p}</loc></sitemap>`)
    .join('')}</sitemapindex>`;

let server: Server;
let dir: string;
let base: string;
let bomb: Buffer;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b73-'));
  bomb = gzipSync(Buffer.alloc(201 * 1024 * 1024, 0x20));
  const big = () => urlset(['/', ...Array.from({ length: 50_000 }, (_, i) => `/p${i}`)]);
  server = createServer((req, res) => {
    const xml = (body: string) => res.writeHead(200, { 'content-type': 'application/xml' }).end(body);
    switch (req.url) {
      case '/robots.txt':
        return void res.writeHead(200, { 'content-type': 'text/plain' }).end(`Sitemap: ${base}/sitemap_index.xml\n`);
      case '/sitemap_index.xml':
        return xml(index(['/big.xml', '/small.xml']));
      case '/big.xml':
        return xml(big());
      case '/small.xml':
        return xml(urlset(['/a', '/b']));
      case '/deep1.xml':
        return xml(index(['/deep2.xml']));
      case '/deep2.xml':
        return xml(index(['/deep3.xml']));
      case '/deep3.xml':
        return xml(index(['/deep4.xml']));
      case '/bomb.xml.gz':
        return void res.writeHead(200, { 'content-type': 'application/gzip' }).end(bomb);
      case '/':
      case '/a':
      case '/b':
        return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>A page title long enough</title></head><body>x</body></html>');
      default:
        return void res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const opts = () => ({
  userAgent: 'test',
  signal: new AbortController().signal,
  timeoutMs: 10_000,
  maxUrls: 50_000,
  maxDepth: 3,
});

describe('fetchSitemaps lists every file (B73)', () => {
  it('a file after the URL cap is still read for its counts', async () => {
    const r = await fetchSitemaps([`${base}/sitemap_index.xml`], opts());
    expect(r.entries.length).toBe(50_000);
    expect(r.truncated).toBe(true);
    const byUrl = new Map(r.files.map((f) => [f.url.slice(base.length), f]));
    expect([...byUrl.keys()]).toEqual(['/sitemap_index.xml', '/big.xml', '/small.xml']);
    expect(byUrl.get('/sitemap_index.xml')).toMatchObject({ status: 200, childCount: 2, urlCount: 0 });
    expect(byUrl.get('/big.xml')).toMatchObject({ status: 200, urlCount: 50_001, reason: null });
    expect(byUrl.get('/big.xml')!.warnings.join()).toMatch(/50,000/);
    expect(byUrl.get('/small.xml')).toMatchObject({ status: 200, urlCount: 2, reason: 'counted-only' });
    expect(r.entries.some((e) => e.url.endsWith('/a'))).toBe(false);
  });

  it('a file nested past the depth limit is listed, not fetched', async () => {
    const r = await fetchSitemaps([`${base}/deep1.xml`], opts());
    const deep4 = r.files.find((f) => f.url.endsWith('/deep4.xml'));
    expect(deep4).toMatchObject({ status: null, bytes: null, reason: 'too-deep' });
  });

  it('a gzip that inflates past the cap is listed as over 50 MB, not read', async () => {
    const r = await fetchSitemaps([`${base}/bomb.xml.gz`], opts());
    expect(r.files[0]).toMatchObject({ status: 200, bytes: bomb.byteLength, reason: 'too-large', urlCount: null });
  });

  it('the validators judge each file, not the whole tree', async () => {
    const r = await fetchSitemaps([`${base}/sitemap_index.xml`], opts());
    const v = validateFetchedSitemaps(r);
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]).toContain(`${base}/big.xml`);
  });
});

it('a crawl stores the files, counts the finding once, and the export agrees (B73)', async () => {
  const db = new ProjectDb(join(dir, 'p.seoproject'));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: `${base}/`,
      maxUrls: 1000,
      maxConcurrency: 2,
      discoverSitemaps: true,
      crawlLinkedSitemaps: false,
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
  const files = [...datasetRows(db, 'sitemap-files')];
  const paths = files.map((f) => String(f.url).slice(base.length));
  expect(paths).toEqual(expect.arrayContaining(['/sitemap_index.xml', '/big.xml', '/small.xml']));
  const found = db.getOverviewCounts().site?.sitemapFindings;
  expect(found?.overUrls.map((f) => f.url)).toEqual([`${base}/big.xml`]);
  expect(found?.overSize).toEqual([]);
  const big = files.find((f) => String(f.url).endsWith('/big.xml'));
  expect(big).toMatchObject({ urlCount: 50_001 });
  db.close();
}, 60_000);

it('a project with no sitemap files read says "not checked", not zero (B73)', () => {
  const db = new ProjectDb(join(dir, 'empty.seoproject'));
  expect(db.getOverviewCounts().site?.sitemapFindings ?? null).toBeNull();
  db.close();
});
