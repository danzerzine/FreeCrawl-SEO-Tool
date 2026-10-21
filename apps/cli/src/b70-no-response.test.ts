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
let deadUrl: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b70-'));
  // A port nothing listens on: bind, read the number, close.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const deadPort = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  deadUrl = `http://127.0.0.1:${deadPort}/gone`;
  server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>Home</title></head><body><a href="${deadUrl}">dead</a></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('a link to a refused connection is a broken link with no response', async () => {
  const dbPath = join(dir, 'c.seoproject');
  await run(process.execPath, [cli, base, '--depth', '1', '--db', dbPath, '--json', '--no-robots'], {
    timeout: 60_000,
  });
  const db = new ProjectDb(dbPath);
  try {
    const { rows, total } = db.queryBrokenLinks({ limit: 50, offset: 0 });
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({ toUrl: deadUrl, toStatusCode: null, isInternal: true });
    const dead = db.getUrlById(db.getUrlIdByUrl(deadUrl)!);
    expect(dead?.indexability).toBe('non-indexable:no-response');
    expect(db.getOverviewCounts().issues.brokenLinksInternal).toBe(1);
  } finally {
    db.close();
  }
}, 90_000);
