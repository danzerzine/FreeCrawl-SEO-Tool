import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Drives the built CLI as a process (`npx tsc -b` and `npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

let dir: string;
let site: http.Server;
let base: string;

// /, linking ten pages; each page a few KB of text.
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b49-'));
  site = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/robots.txt' || url.startsWith('/sitemap')) return void res.writeHead(404).end();
    const links = url === '/' ? Array.from({ length: 10 }, (_, i) => `<a href="/p/${i}">p${i}</a>`) : [];
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<html><head><title>${url}</title></head><body><h1>${url}</h1>${links.join('')}` +
        `<p>${'Some words on the page. '.repeat(200)}</p></body></html>`,
    );
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});

afterEach(async () => {
  await new Promise((r) => site.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

type Exit = { code: number | null; out: string; err: string };

function start(args: string[]): { child: ChildProcess; done: Promise<Exit>; err: () => string } {
  const child = spawn(process.execPath, [CLI, ...args]);
  let out = '';
  let err = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (err += d));
  const done = new Promise<Exit>((r) => child.on('exit', (code) => r({ code, out, err })));
  return { child, done, err: () => err };
}

const db = (name: string) => path.join(dir, `${name}.seoproject`);

describe('--parse-workers (B49)', () => {
  it('parses every page on the workers; under --json every stderr line is JSON', async () => {
    const r = await start([base, '--parse-workers', '2', '--verbose', '--json', '--db', db('pool')]).done;
    expect(r.code).toBe(0);
    const lines = r.err.split('\n').filter((l) => l.trim() !== '');
    const events = lines.map((l) => JSON.parse(l) as { type: string; message?: string });
    const messages = events.map((e) => e.message ?? '');
    expect(messages).toContain('parser-pool: spawned 2 parser worker(s)');
    expect(messages).toContain('parser-pool: 11 page(s) parsed on worker threads');
    const json = JSON.parse(r.out) as { summary: { total: number; peakRssMb: number } };
    expect(json.summary.total).toBe(11);
    expect(Number.isInteger(json.summary.peakRssMb) && json.summary.peakRssMb > 0).toBe(true);
  });

  it('defaults to min(4, cores - 1) workers (PC measurement, 2.05x faster)', async () => {
    const want = Math.min(4, os.cpus().length - 1);
    const r = await start([base, '--verbose', '--json', '--db', db('default')]).done;
    expect(r.code).toBe(0);
    const messages = r.err
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => (JSON.parse(l) as { message?: string }).message ?? '');
    if (want > 0) expect(messages).toContain(`parser-pool: spawned ${want} parser worker(s)`);
    else expect(messages.some((m) => m.startsWith('parser-pool: spawned'))).toBe(false);
  });

  it('prints the peak memory in the Done line', async () => {
    const r = await start([base, '--db', db('done')]).done;
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Done\. Total=11 .* PeakMem=\d+MB/);
  });

  it('refuses a worker count that is not a whole number', async () => {
    for (const bad of ['-1', '1.5', 'x']) {
      const r = await start([base, '--parse-workers', bad, '--db', db('bad')]).done;
      expect(r.code).toBe(2);
      expect(r.err).toContain('--parse-workers');
    }
  });
});

describe('--memory-limit (B49)', () => {
  it('refuses a limit that is not a positive whole number', async () => {
    for (const bad of ['0', '-5', '1.5', 'x']) {
      const r = await start([base, '--memory-limit', bad, '--db', db('bad')]).done;
      expect(r.code).toBe(2);
      expect(r.err).toContain('--memory-limit');
    }
  });

  it('pauses the crawl at the limit', async () => {
    // 1 MB is below any process: the watchdog pauses at its first sample.
    const run = start([base, '--memory-limit', '1', '--rps', '1', '--db', db('mem')]);
    const deadline = Date.now() + 15_000;
    while (!run.err().includes('Memory limit reached') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    run.child.kill('SIGKILL');
    await run.done;
    expect(run.err()).toContain('Memory limit reached: RSS');
  });
});
