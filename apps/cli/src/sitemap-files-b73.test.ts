import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const run = promisify(execFile);
let server: Server;
let dir: string;
let base: string;

/* /sitemap_index.xml lists /big.xml (50 001 URLs) and then /small.xml. */
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b73-cli-'));
  const urlset = (paths: string[]) =>
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((p) => `<url><loc>${base}${p}</loc></url>`).join('')}</urlset>`;
  server = createServer((req, res) => {
    const xml = (body: string) => res.writeHead(200, { 'content-type': 'application/xml' }).end(body);
    if (req.url === '/robots.txt') return void res.writeHead(200).end(`Sitemap: ${base}/sitemap_index.xml\n`);
    if (req.url === '/sitemap_index.xml')
      return xml(
        `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${base}/big.xml</loc></sitemap><sitemap><loc>${base}/small.xml</loc></sitemap></sitemapindex>`,
      );
    if (req.url === '/big.xml') return xml(urlset(['/', ...Array.from({ length: 50_000 }, (_, i) => `/p${i}`)]));
    if (req.url === '/small.xml') return xml(urlset(['/a']));
    if (req.url === '/' || req.url === '/a')
      return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>Home page title</title></head><body>x</body></html>');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('--json, sitemap-files.csv and validate-sitemap name the same file over 50,000 URLs (B73)', async () => {
  const dbPath = join(dir, 'c.seoproject');
  const crawl = await run(process.execPath, [cli, `${base}/`, '--max', '5', '--db', dbPath, '--json'], {
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  }).catch((e: { stdout: string }) => e);
  const j = JSON.parse(crawl.stdout) as {
    sitemapFindings: { overUrls: { url: string; urlCount: number }[]; overSize: unknown[] } | null;
  };
  expect(j.sitemapFindings?.overUrls.map((f) => [f.url, f.urlCount])).toEqual([[`${base}/big.xml`, 50_001]]);
  expect(j.sitemapFindings?.overSize).toEqual([]);

  const out = join(dir, 'out');
  await run(process.execPath, [cli, 'export', '--project', dbPath, '--out', out, '--what', 'dataset:sitemap-files'], {
    timeout: 60_000,
  });
  const csv = readFileSync(join(out, 'sitemap-files.csv'), 'utf8');
  const big = csv.split('\n').find((l) => l.includes('/big.xml'));
  expect(big).toContain(',50001,');
  expect(csv).toContain('/small.xml');

  const v = await run(process.execPath, [cli, 'validate-sitemap', `${base}/sitemap_index.xml`], {
    timeout: 60_000,
  }).catch((e: { stdout: string; code: number }) => e);
  expect('code' in v ? v.code : 0).toBe(1);
  expect(v.stdout).toContain(`${base}/big.xml: Sitemap declares 50,001 URLs`);
}, 120_000);
