import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { exportSitemap } from '@freecrawl/core';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const run = promisify(execFile);
let server: Server;
let dir: string;
let base: string;
let project: string;

/*
 * A real crawl of a local server (B61, «Done when» 5):
 *  /      Last-Modified 2026-02-01, sitemap says the same day
 *  /old   Last-Modified 2026-03-01, sitemap says 2026-05-01 (a real difference)
 *  /now   Last-Modified = the moment of the request (a server stamping "now"),
 *         sitemap says 2026-02-02
 */
const SITEMAP: Record<string, string> = { '/': '2026-02-01', '/old': '2026-05-01', '/now': '2026-02-02' };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b61-cli-'));
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/robots.txt') return void res.writeHead(200).end(`Sitemap: ${base}/sitemap.xml\n`);
    if (url === '/sitemap.xml') {
      const entries = Object.entries(SITEMAP)
        .map(([p, d]) => `<url><loc>${base}${p}</loc><lastmod>${d}</lastmod></url>`)
        .join('');
      return void res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`);
    }
    const modified: Record<string, string> = {
      '/': new Date('2026-02-01T08:00:00Z').toUTCString(),
      '/old': new Date('2026-03-01T08:00:00Z').toUTCString(),
      '/now': new Date().toUTCString(),
    };
    if (modified[url]) {
      return void res
        .writeHead(200, { 'content-type': 'text/html', 'last-modified': modified[url] })
        .end(
          `<html><head><title>Page ${url} for the lastmod test</title></head><body><a href="/old">old</a><a href="/now">now</a></body></html>`,
        );
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  project = join(dir, 'c.seoproject');
  await run(process.execPath, [cli, `${base}/`, '--db', project, '--json'], { encoding: 'utf8' }).catch((e) => e);
}, 90000);

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('the generated sitemap takes the page date, and a server stamping "now" falls back to the sitemap date', async () => {
  const db = new ProjectDb(project);
  const out = join(dir, 'sitemap.xml');
  await exportSitemap(db, out);
  db.close();
  const xml = readFileSync(out, 'utf8');
  const lastmod = (p: string) => new RegExp(`<loc>${base}${p}</loc>\\s*<lastmod>([^<]*)</lastmod>`).exec(xml)?.[1];
  expect(lastmod('/old')).toBe('2026-03-01');
  expect(lastmod('/')).toBe('2026-02-01');
  // Last-Modified is "now": rejected, the lastmod comes from the sitemap.
  expect(lastmod('/now')).toBe('2026-02-02');
});

it('the reconciliation flags the older-header route and not the "now" route (guarded value)', async () => {
  const outDir = join(dir, 'rec');
  await run(
    process.execPath,
    [cli, 'export', '--project', project, '--out', outDir, '--raw-headers', '--what', 'dataset:sitemap-reconciliation'],
    { encoding: 'utf8' },
  );
  const rows = readFileSync(join(outDir, 'sitemap-reconciliation.csv'), 'utf8').trim().split('\n').slice(1);
  const row = (p: string) => rows.find((l) => l.startsWith(`${base}${p},`))?.split(',');
  // url,inCrawl,inSitemap,statusCode,indexability,sitemapLastmod,lastModifiedHeader,lastmodDiffDays,verdict,note
  expect(row('/old')?.slice(5)).toEqual(['2026-05-01', '2026-03-01', '61', 'lastmod-differs', '']);
  expect(row('/now')?.slice(5)).toEqual(['2026-02-02', '', '', 'ok', '']);
  expect(row('/')?.slice(5)).toEqual(['2026-02-01', '2026-02-01', '0', 'ok', '']);
});
