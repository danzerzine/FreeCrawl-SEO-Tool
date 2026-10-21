import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { datasetRows } from './dataset-export.js';

/*
 * robots.txt names /sitemap.xml (an index of /one.xml and /two.xml), and the
 * crawl is also seeded with /sitemap.xml, so that file arrives twice.
 * /shared is in both /one.xml and /two.xml; /twice is listed twice in
 * /one.xml.
 */
let server: Server;
let dir: string;
let base: string;
const urlset = (paths: string[]) =>
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
    .map((p) => `<url><loc>${base}${p}</loc></url>`)
    .join('')}</urlset>`;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b27-'));
  server = createServer((req, res) => {
    const xml = (body: string) => res.writeHead(200, { 'content-type': 'application/xml' }).end(body);
    switch (req.url) {
      case '/robots.txt':
        return void res.writeHead(200).end(`Sitemap: ${base}/sitemap.xml\n`);
      case '/sitemap.xml':
        return xml(
          `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${base}/one.xml</loc></sitemap><sitemap><loc>${base}/two.xml</loc></sitemap></sitemapindex>`,
        );
      case '/one.xml':
        return xml(urlset(['/', '/shared', '/twice', '/twice']));
      case '/two.xml':
        return xml(urlset(['/shared', '/only-two']));
      default:
        if (req.url?.startsWith('/sitemap') || req.url?.endsWith('.xml')) return void res.writeHead(404).end();
        return void res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<html><head><title>A page title long enough</title></head><body>x</body></html>');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('a URL in two sitemaps and a URL listed twice in one each count once; a file read twice adds nothing (B27)', async () => {
  const db = new ProjectDb(join(dir, 'p.seoproject'));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: `${base}/`,
      maxUrls: 20,
      maxConcurrency: 2,
      discoverSitemaps: true,
      seedSitemapUrls: [`${base}/sitemap.xml`],
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
  const found = db.getOverviewCounts().site?.sitemapFindings;
  expect(found?.inSeveral).toEqual({ count: 1, sample: [`${base}/shared`] });
  expect(found?.duplicateEntries.map((f) => [f.url, f.duplicateEntries])).toEqual([[`${base}/one.xml`, 1]]);

  const urls = [...datasetRows(db, 'sitemap-urls')];
  expect(urls.filter((r) => Number(r.sitemapCount) > 1).map((r) => r.url)).toEqual([`${base}/shared`]);
  expect(urls).toHaveLength(4);
  const files = [...datasetRows(db, 'sitemap-files')];
  expect(files.find((f) => String(f.url).endsWith('/one.xml'))).toMatchObject({ duplicateEntries: 1 });
  expect(files.find((f) => String(f.url).endsWith('/two.xml'))).toMatchObject({ duplicateEntries: 0 });

  // The sitemap page checks read sitemap_urls as before.
  expect(db.countSitemapUrls()).toBe(4);
  db.close();
}, 60_000);
