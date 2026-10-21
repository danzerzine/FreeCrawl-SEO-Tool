import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const run = promisify(execFile);
let server: Server;
let dir: string;
let base: string;

/* The sitemap lists six pages; the home page links to none of them. */
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b76-cli-'));
  const paths = ['/', '/s1', '/s2', '/s3', '/s4', '/s5'];
  server = createServer((req, res) => {
    if (req.url === '/robots.txt') return void res.writeHead(200).end(`Sitemap: ${base}/sitemap.xml\n`);
    if (req.url === '/sitemap.xml')
      return void res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((p) => `<url><loc>${base}${p}</loc></url>`).join('')}</urlset>`,
        );
    if (paths.includes(req.url ?? ''))
      return void res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(`<html><head><title>Page ${req.url} title</title></head><body>x</body></html>`);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('--json gives the sidebar number of sitemap URLs not crawled and the page limit it stopped at (B76)', async () => {
  const dbPath = join(dir, 'c.seoproject');
  const crawl = await run(process.execPath, [cli, `${base}/`, '--max', '3', '--db', dbPath, '--json'], {
    timeout: 60_000,
  }).catch((e: { stdout: string }) => e);
  const j = JSON.parse(crawl.stdout) as {
    issues: { sitemapNotCrawled: number };
    site: { crawlStoppedAtLimit: number | null };
  };
  const db = new ProjectDb(dbPath);
  const sidebar = db.getOverviewCounts();
  const orphans = db.sitemapOrphans().length;
  db.close();
  expect(j.issues.sitemapNotCrawled).toBeGreaterThan(0);
  expect(j.issues.sitemapNotCrawled).toBe(sidebar.issues.sitemapNotCrawled);
  expect(orphans).toBe(j.issues.sitemapNotCrawled);
  expect(j.site.crawlStoppedAtLimit).toBe(3);

  const text = await run(process.execPath, [cli, `${base}/`, '--max', '3', '--db', join(dir, 't.seoproject')], {
    timeout: 60_000,
  }).catch((e: { stdout: string }) => e);
  expect(text.stdout).toContain('sitemap URL(s) not crawled (the crawl stopped at its limit of 3 pages)');
}, 120_000);
