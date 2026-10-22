import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Drives the built CLI as a process (`npm run build:cli` first).
const CLI = join(__dirname, '../dist/index.js');

let dir: string;
let site: Server;
let base: string;
let pageHits: number[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b30-cli-'));
  site = createServer((req, res) => {
    const m = /^\/p\/(\d+)$/.exec(req.url ?? '');
    if (!m && req.url !== '/') return void res.writeHead(404).end();
    pageHits.push(Date.now());
    const k = m ? Number(m[1]) : 0;
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(`<html><body><a href="/p/${k * 2 + 1}">a</a><a href="/p/${k * 2 + 2}">b</a></body></html>`);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(() => {
  site.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  pageHits = [];
});

let n = 0;
function cli(args: string[], file?: object): Promise<{ code: number | null; err: string }> {
  const db = join(dir, `p${++n}.seoproject`);
  const extra: string[] = [];
  if (file) {
    const path = join(dir, `c${n}.json`);
    writeFileSync(path, JSON.stringify(file));
    extra.push('--config', path);
  }
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [
      CLI,
      `${base}/`,
      '--db',
      db,
      '--max',
      '6',
      '--rps',
      '50',
      '--no-robots',
      '--no-sitemap-discovery',
      ...args,
      ...extra,
    ]);
    let err = '';
    p.stdout.resume();
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => resolve({ code, err }));
  });
}

const hour = new Date().getHours();
const gaps = () => pageHits.slice(1).map((t, i) => t - pageHits[i]!);

describe('--night-rps / --night (B30)', () => {
  it('inside the window pages come at the night rate', async () => {
    const { code } = await cli(['--night-rps', '2', '--night', `${hour}-${(hour + 1) % 24}`]);
    expect(code).toBe(0);
    expect(gaps().length).toBeGreaterThanOrEqual(5);
    for (const g of gaps()) expect(g).toBeGreaterThanOrEqual(450);
  }, 30_000);

  it('outside it at --rps', async () => {
    const { code } = await cli(['--night-rps', '2', '--night', `${(hour + 1) % 24}-${(hour + 2) % 24}`]);
    expect(code).toBe(0);
    expect(Math.max(...gaps())).toBeLessThan(400);
  }, 30_000);

  it('a night rate from the file takes a --night window', async () => {
    const { code } = await cli(['--night', `${hour}-${(hour + 1) % 24}`], { nightMaxRps: 2 });
    expect(code).toBe(0);
    for (const g of gaps()) expect(g).toBeGreaterThanOrEqual(450);
  }, 30_000);

  it('the same start and end hour is no window, with a warning', async () => {
    const { code, err } = await cli(['--night-rps', '2', '--night', `${hour}-${hour}`]);
    expect(code).toBe(0);
    expect(err).toMatch(/\[warn\].*night/i);
    expect(Math.max(...gaps())).toBeLessThan(400);
  }, 30_000);

  it.each([['25-3'], ['3'], ['a-b'], ['-1-4'], ['3-24']])('--night %s exits 2', async (value) => {
    const { code, err } = await cli(['--night-rps', '2', '--night', value]);
    expect(code).toBe(2);
    expect(err).toMatch(/--night/);
    expect(pageHits).toEqual([]);
  });

  it('--night without a night rate exits 2', async () => {
    const { code, err } = await cli(['--night', '1-5']);
    expect(code).toBe(2);
    expect(err).toContain('--night needs --night-rps');
  });

  it('a bad --night-rps exits 2', async () => {
    const { code } = await cli(['--night-rps', 'fast']);
    expect(code).toBe(2);
  });
});
