import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const run = promisify(execFile);
let server: Server;
let dir: string;
let base: string;

// A home page linking 110 article pages; no page sends a Content-Security-Policy.
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b78-'));
  const links = Array.from({ length: 110 }, (_, i) => `<a href="/p${i}">Article ${i}</a>`).join('');
  server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      req.url === '/'
        ? `<html><head><title>Home page of the test site</title></head><body>${links}</body></html>`
        : `<html><head><title>Article ${req.url} of the test site</title></head><body><p>Text</p></body></html>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('--json lists the site-wide checks with the pages answered 200', async () => {
  const dbPath = join(dir, 'c.seoproject');
  const { stdout } = await run(process.execPath, [cli, base, '--depth', '1', '--db', dbPath, '--json', '--no-robots'], {
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = JSON.parse(stdout) as {
    site: { siteWide?: { pagesBase: number; checks: { category: string; pages: number }[] } };
  };
  expect(out.site.siteWide?.pagesBase).toBe(111);
  expect(out.site.siteWide?.checks).toContainEqual({ category: 'issues:csp-missing', pages: 111 });
}, 150_000);
