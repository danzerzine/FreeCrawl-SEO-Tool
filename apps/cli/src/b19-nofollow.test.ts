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
const hits: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b19-'));
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/robots.txt') {
      res.writeHead(404).end();
      return;
    }
    if (req.url === '/r') {
      res.writeHead(301, { location: '/m' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      req.url === '/'
        ? '<html><head><title>Home</title></head><body><a href="/a">a</a> <a rel="nofollow" href="/n">n</a>' +
            ' <a href="/r">r</a> <a rel="nofollow" href="/m">m</a></body></html>'
        : '<html><head><title>x</title></head><body>leaf</body></html>',
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('a nofollow internal link is stored with its rel but its target is not fetched', async () => {
  const dbPath = join(dir, 'c.seoproject');
  await run(process.execPath, [cli, base, '--depth', '2', '--db', dbPath, '--json', '--no-robots'], {
    timeout: 60_000,
  });
  const db = new ProjectDb(dbPath);
  try {
    const home = db.getUrlById(db.getUrlIdByUrl(base)!)!;
    const { rows } = db.getOutlinks(home.id, 50);
    const n = rows.find((r) => r.toUrl.endsWith('/n'));
    expect(n?.rel).toContain('nofollow');
    expect(rows.some((r) => r.toUrl.endsWith('/a'))).toBe(true);
  } finally {
    db.close();
  }
  expect(hits).toContain('/a');
  expect(hits).not.toContain('/n');
}, 90_000);

it('a page fetched via a redirect and linked only with nofollow is an orphan by default', async () => {
  const dbPath = join(dir, 'm.seoproject');
  await run(process.execPath, [cli, base, '--depth', '3', '--db', dbPath, '--json', '--no-robots'], {
    timeout: 60_000,
  });
  const db = new ProjectDb(dbPath);
  try {
    const m = db.getUrlById(db.getUrlIdByUrl(`${base}m`)!)!;
    expect(m.inlinks).toBe(0);
    expect([...db.iterateUrlsByCategory('issues:orphan-page')].map((r) => r.url)).toContain(`${base}m`);
    expect(
      [...db.iterateUrlsByCategory('issues:inlinks-nofollow-only')].map((r) => r.url),
    ).toEqual([`${base}m`]);
  } finally {
    db.close();
  }
}, 90_000);
