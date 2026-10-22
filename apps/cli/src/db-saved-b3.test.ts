import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { packProject, ProjectDb } from '@freecrawl/db';

// Drives the built CLI as a process (`npm run build:cli` first).
const CLI = join(__dirname, '../dist/index.js');

let dir: string;
let server: Server;
let base: string;
let hits = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b3-db-'));
  server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>t</title></head><body>x</body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Async, not spawnSync: the test server in this process must answer. */
function crawl(db: string, ...extra: string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, base, '--db', db, '--max', '2', '--no-sitemap-discovery', ...extra]);
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d));
    p.on('exit', (status) => resolve({ status, stderr }));
  });
}

it.each([[[]], [['--resume']]])('a crawl into a project saved by the desktop app exits 2 and leaves it as it was %j (B3)', async (extra) => {
  const bare = join(dir, 'bare.db');
  new ProjectDb(bare).close();
  const saved = join(dir, 'saved.seoproject');
  await packProject(bare, saved);
  const before = readFileSync(saved);
  hits = 0;
  const r = await crawl(saved, ...extra);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('was saved by the desktop app; crawl into a new --db path');
  expect(readFileSync(saved).equals(before)).toBe(true);
  expect(hits).toBe(0);
});

it('a --db that is no project exits 2 (B3)', async () => {
  const junk = join(dir, 'junk.seoproject');
  writeFileSync(junk, 'just some text');
  const r = await crawl(junk);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('is not a FreeCrawl project');
  expect(readFileSync(junk, 'utf8')).toBe('just some text');
});

it('an empty --db file is a new project, as before (B3)', async () => {
  const empty = join(dir, 'empty.seoproject');
  writeFileSync(empty, '');
  const r = await crawl(empty);
  expect(r.status).toBe(0);
  const db = new ProjectDb(empty, { readOnly: true });
  expect(db.countUrls()).toBeGreaterThan(0);
  db.close();
});
