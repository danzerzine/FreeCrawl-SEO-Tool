import { spawn } from 'node:child_process';
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
let delayMs = 0;
let with404 = false;
let crawlDelay = false;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b48-'));
  delayMs = 0;
  with404 = false;
  crawlDelay = false;
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    // No robots.txt and no sitemap: the crawl must still count as clean.
    if (url === '/robots.txt' && crawlDelay) {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nCrawl-delay: 2\n');
      return;
    }
    if (url === '/robots.txt' || url.startsWith('/sitemap')) {
      res.writeHead(404).end();
      return;
    }
    if (url === '/missing') {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<html><body>gone</body></html>');
      return;
    }
    const m = /^\/p\/(\d+)$/.exec(url);
    const i = m ? Number(m[1]) : 0;
    const links = [`<a href="/p/${i + 1}">next</a>`];
    if (with404 && i === 0) links.push('<a href="/missing">missing</a>');
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head><title>p${i}</title></head><body>${links.join('')}</body></html>`);
    }, delayMs);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

// Async: the test server runs in this process, so a blocking spawn would
// starve it.
function crawl(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, ...args, '--db', path.join(dir, `c${Math.random()}.seoproject`)]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  return new Promise((r) => child.on('exit', (status) => r({ status, stdout, stderr })));
}

describe('exit codes (B48)', () => {
  it('a clean crawl exits 0 even with no robots.txt and no sitemap; warnings go to stderr', async () => {
    const r = await crawl([base, '--max', '5', '--json']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ ok: true, complete: true, interrupted: false });
  }, 30000);

  it('a crawl that finds a 404 exits 1', async () => {
    with404 = true;
    const r = await crawl([base, '--max', '5', '--json']);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ complete: true });
  }, 30000);

  it('an unreachable start URL exits 4 and says the crawl did not complete', async () => {
    const r = await crawl(['http://127.0.0.1:9/', '--json']);
    expect(r.status).toBe(4);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, complete: false, interrupted: false });
  }, 30000);
});

describe('stderr while the crawl runs (B48)', () => {
  it('--json: progress lines every 10 s, each stderr line is JSON, stdout one document', async () => {
    delayMs = 1500;
    const child = spawn(process.execPath, [CLI, base, '--max', '9', '--concurrency', '1', '--json',
      '--db', path.join(dir, 'slow.seoproject')]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    expect(code).toBe(0);
    const lines = err.split('\n').filter((l) => l.trim() !== '');
    const events = lines.map((l) => JSON.parse(l) as { type: string; time: string });
    const progress = events.filter((e) => e.type === 'progress');
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress[0]).toHaveProperty('crawled');
    expect(Number.isNaN(Date.parse(progress[0]!.time))).toBe(false);
    expect(JSON.parse(out)).toMatchObject({ complete: true });
  }, 40000);

  it('warn events print on stderr: [warn] lines in text mode, JSON lines with --json', async () => {
    crawlDelay = true;
    const text = await crawl([base, '--max', '2']);
    expect(text.status).toBe(0);
    expect(text.stderr).toMatch(/^\[warn\] robots\.txt declares Crawl-delay/m);
    const json = await crawl([base, '--max', '2', '--json']);
    const warns = json.stderr
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { type: string; message: string })
      .filter((e) => e.type === 'warn');
    expect(warns.some((w) => w.message.includes('Crawl-delay'))).toBe(true);
  }, 30000);

  it('--verbose prints info events; without it they stay quiet', async () => {
    const quiet = await crawl([base, '--max', '2']);
    expect(quiet.stderr).not.toContain('[info]');
    const loud = await crawl([base, '--max', '2', '--verbose']);
    expect(loud.stderr).toContain('[info] Start URL resolved');
  }, 30000);
});
