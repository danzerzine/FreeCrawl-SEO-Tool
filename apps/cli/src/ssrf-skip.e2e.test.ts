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
let privateUrl: string;
const hits: string[] = [];

// The start URL is loopback written as an IPv4-mapped IPv6 address, which
// the SSRF guard does not treat as private; the page links to 127.0.0.1,
// which it does. So the link is an external link to a private address.
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ssrf-'));
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/robots.txt') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>Home</title></head><body><a href="${privateUrl}">admin</a></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '::', r));
  const port = (server.address() as { port: number }).port;
  base = `http://[::ffff:7f00:1]:${port}/`;
  privateUrl = `http://127.0.0.1:${port}/admin`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('a link to a private address skipped by the SSRF guard is not a broken link', async () => {
  const dbPath = join(dir, 'c.seoproject');
  await run(process.execPath, [cli, base, '--depth', '1', '--db', dbPath, '--json', '--no-robots'], {
    timeout: 60_000,
  });
  expect(hits).not.toContain('/admin');
  const db = new ProjectDb(dbPath);
  try {
    const row = db.getUrlById(db.getUrlIdByUrl(privateUrl)!)!;
    expect(row.statusText).toContain('SSRF guard');
    expect(db.queryBrokenLinks({ limit: 50, offset: 0 }).total).toBe(0);
    expect(db.getOverviewCounts().issues.brokenLinksExternal).toBe(0);
    expect(row.indexability).not.toBe('non-indexable:no-response');
  } finally {
    db.close();
  }
}, 90_000);
