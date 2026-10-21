import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Drives the built CLI as a process (`npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

let dir: string;
let server: http.Server;
let base: string;
const pageHits: number[] = [];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cli-'));
  pageHits.length = 0;
  server = http.createServer((req, res) => {
    const m = /^\/p\/(\d+)$/.exec(req.url ?? '');
    if (m) pageHits.push(Date.now());
    const i = m ? Number(m[1]) : 0;
    res.setHeader('content-type', 'text/html');
    res.end(`<html><head><title>p${i}</title></head><body>` +
      [1, 2, 3].map((k) => `<a href="/p/${i * 3 + k}">x</a>`).join('') + '</body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('crawl rate flags', () => {
  it.each(['abc', '-1', '0.5x', ''])('--rps=%j exits 2 and writes no project', (v) => {
    const db = path.join(dir, 'bad.seoproject');
    const r = spawnSync(process.execPath, [CLI, base, `--rps=${v}`, '--db', db], { encoding: 'utf8', timeout: 10000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Invalid --rps');
    expect(fs.existsSync(db)).toBe(false);
  });

  it('--depth 1.5 exits 2: depth must be a whole number', () => {
    const r = spawnSync(process.execPath, [CLI, base, '--depth', '1.5', '--db', path.join(dir, 'd.seoproject')], { encoding: 'utf8', timeout: 10000 });
    expect(r.status).toBe(2);
  });

  it('--rps 0.5 spaces page requests about 2 s apart instead of turning the limit off', async () => {
    const child = spawn(process.execPath, [CLI, base, '--rps', '0.5', '--concurrency', '4', '--no-robots',
      '--db', path.join(dir, 't.seoproject')], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 7000));
    child.kill();
    // Before the fix parseInt('0.5') = 0 = unlimited: hundreds of hits in 7 s.
    expect(pageHits.length).toBeGreaterThanOrEqual(2);
    expect(pageHits.length).toBeLessThanOrEqual(4);
    const gaps = pageHits.slice(1).map((t, k) => t - pageHits[k]!);
    for (const g of gaps) expect(g).toBeGreaterThan(1800);
  }, 15000);
});
