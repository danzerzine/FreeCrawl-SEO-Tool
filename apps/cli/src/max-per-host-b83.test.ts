import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Drives the built CLI as a process (`npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

let dir: string;
let site: http.Server;
let port: number;
let delayMs = 0;
let hits: Record<string, number> = {};

// Two host names for one server: 127.0.0.1 and localhost. /hub links six
// pages and an image, /p/6 links /p/7; every page answers HTML. /list.txt and /list.csv
// serve URL lists; /missing is a 404.
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b83-'));
  delayMs = 0;
  hits = {};
  site = http.createServer((req, res) => {
    const url = req.url ?? '/';
    hits[url] = (hits[url] ?? 0) + 1;
    const host = `http://${req.headers.host}`;
    if (url === '/robots.txt' || url.startsWith('/sitemap') || url === '/missing') {
      return void res.writeHead(404).end();
    }
    if (url === '/list.txt') {
      return void res
        .writeHead(200, { 'content-type': 'text/plain' })
        .end(`${listOf('127.0.0.1', 2).join('\n')}\n# comment\n`);
    }
    if (url === '/list.csv') {
      const rows = listOf('127.0.0.1', 2).map((u) => `"${u}","a, b"`);
      return void res
        .writeHead(200, { 'content-type': 'text/csv' })
        .end(['url,note', ...rows].join('\r\n'));
    }
    if (url === '/logo.png') return void res.writeHead(200, { 'content-type': 'image/png' }).end('png');
    const links =
      url === '/hub'
        ? ['<img src="/logo.png">', ...[1, 2, 3, 4, 5, 6].map((i) => `<a href="${host}/p/${i}">p</a>`)]
        : url === '/p/6'
          ? ['<a href="/p/7">p</a>']
          : [];
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head><title>${url}</title></head><body>${links.join('')}</body></html>`);
    }, delayMs);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  port = (site.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise((r) => site.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

function listOf(host: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `http://${host}:${port}/p/${i + 1}`);
}

type Exit = { code: number | null; out: string; err: string };

function start(args: string[], stdin?: string): { child: ChildProcess; done: Promise<Exit> } {
  const child = spawn(process.execPath, [CLI, '--concurrency', '1', ...args]);
  let out = '';
  let err = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (err += d));
  if (stdin !== undefined) child.stdin!.end(stdin);
  const done = new Promise<Exit>((r) => child.on('exit', (code) => r({ code, out, err })));
  return { child, done };
}

/** Fetched internal HTML pages per host name. */
function pagesByHost(db: string): Record<string, number> {
  const raw = new DatabaseSync(db, { readOnly: true });
  try {
    const rows = raw
      .prepare(
        "SELECT url FROM urls WHERE is_external = 0 AND content_kind = 'html' AND status_code IS NOT NULL",
      )
      .all() as { url: string }[];
    const by: Record<string, number> = {};
    for (const { url } of rows) {
      const h = new URL(url).hostname;
      by[h] = (by[h] ?? 0) + 1;
    }
    return by;
  } finally {
    raw.close();
  }
}

function fetchedCount(db: string): number {
  const raw = new DatabaseSync(db, { readOnly: true });
  try {
    return (
      raw.prepare('SELECT COUNT(*) AS n FROM urls WHERE status_code IS NOT NULL').get() as { n: number }
    ).n;
  } finally {
    raw.close();
  }
}

describe('--max-per-host (B83)', () => {
  it('caps pages per host name in a list and reports the skipped URLs', async () => {
    const list = path.join(dir, 'urls.txt');
    fs.writeFileSync(list, [...listOf('127.0.0.1', 6), ...listOf('localhost', 6)].join('\n'));
    const db = path.join(dir, 'two.seoproject');
    const r = await start(['--list', list, '--max-per-host', '3', '--db', db, '--json']).done;
    expect(r.code).toBe(0);
    expect(pagesByHost(db)).toEqual({ '127.0.0.1': 3, localhost: 3 });
    const json = JSON.parse(r.out) as { site: { hostLimitSkipped: { host: string; skipped: number }[] } };
    expect(json.site.hostLimitSkipped).toEqual([
      { host: '127.0.0.1', skipped: 3 },
      { host: 'localhost', skipped: 3 },
    ]);
  });

  it('does not count images toward the limit in a spider crawl', async () => {
    const db = path.join(dir, 'spider.seoproject');
    const r = await start([`http://127.0.0.1:${port}/hub`, '--max-per-host', '4', '--db', db]).done;
    expect(r.code).toBe(0);
    // /hub and three of its six pages; the image is fetched besides them.
    expect(pagesByHost(db)).toEqual({ '127.0.0.1': 4 });
    expect(fetchedCount(db)).toBe(5);
  });

  it('keeps counting from the saved pages on --resume', async () => {
    const list = path.join(dir, 'urls.txt');
    fs.writeFileSync(list, [...listOf('127.0.0.1', 6), ...listOf('localhost', 6)].join('\n'));
    const db = path.join(dir, 'resume.seoproject');
    delayMs = 300;
    const first = start(['--list', list, '--max-per-host', '3', '--db', db]);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (fs.existsSync(db) && (pagesByHost(db)['127.0.0.1'] ?? 0) >= 2) break;
    }
    first.child.kill('SIGINT');
    await first.done;
    delayMs = 0;
    const r = await start(['--list', list, '--max-per-host', '3', '--db', db, '--resume']).done;
    expect(r.code).toBe(0);
    expect(pagesByHost(db)).toEqual({ '127.0.0.1': 3, localhost: 3 });
  });

  // Stops a spider crawl of /hub once two pages are saved, then resumes it.
  async function stopAndResume(limit: string, db: string): Promise<Exit> {
    const hub = `http://127.0.0.1:${port}/hub`;
    delayMs = 300;
    const first = start([hub, '--max-per-host', limit, '--db', db]);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (fs.existsSync(db) && (pagesByHost(db)['127.0.0.1'] ?? 0) >= 2) break;
    }
    first.child.kill('SIGINT');
    await first.done;
    delayMs = 0;
    hits = {};
    return start([hub, '--max-per-host', limit, '--db', db, '--resume']).done;
  }

  it('keeps counting from the saved pages when a spider crawl resumes', async () => {
    const db = path.join(dir, 'spider-resume.seoproject');
    const r = await stopAndResume('4', db);
    expect(r.code).toBe(0);
    // The saved queue held the image; it still does not count.
    expect(pagesByHost(db)).toEqual({ '127.0.0.1': 4 });
  });

  it('counts a page the resume queues twice once', async () => {
    const db = path.join(dir, 'spider-twice.seoproject');
    const r = await stopAndResume('8', db);
    expect(r.code).toBe(0);
    // /hub, /p/1-6 and /p/7, found on /p/6 after the resume.
    expect(pagesByHost(db)).toEqual({ '127.0.0.1': 8 });
    // Each saved page is fetched once by the resume.
    expect(Object.entries(hits).filter(([u, n]) => u.startsWith('/p/') && n > 1)).toEqual([]);
  });

  it('refuses a limit that is not a positive whole number', async () => {
    for (const bad of ['0', '-1', '2.5', 'x']) {
      const r = await start([`http://127.0.0.1:${port}/hub`, '--max-per-host', bad, '--db', path.join(dir, 'x.seoproject')]).done;
      expect(r.code).toBe(2);
      expect(r.err).toContain('--max-per-host');
    }
  });
});

describe('--list sources (B83)', () => {
  it('reads the list from a link', async () => {
    const db = path.join(dir, 'url.seoproject');
    const r = await start(['--list', `http://127.0.0.1:${port}/list.txt`, '--db', db]).done;
    expect(r.code).toBe(0);
    expect(pagesByHost(db)).toEqual({ '127.0.0.1': 2 });
  });

  it('reads the first column of a CSV link, quoted fields and header included', async () => {
    const db = path.join(dir, 'csv.seoproject');
    const r = await start(['--list', `http://127.0.0.1:${port}/list.csv`, '--db', db]).done;
    expect(r.code).toBe(0);
    expect(pagesByHost(db)).toEqual({ '127.0.0.1': 2 });
  });

  it('reads the list from standard input with -', async () => {
    const db = path.join(dir, 'stdin.seoproject');
    const r = await start(['--list', '-', '--db', db], listOf('localhost', 3).join('\n') + '\n').done;
    expect(r.code).toBe(0);
    expect(pagesByHost(db)).toEqual({ localhost: 3 });
  });

  it('exits 2 when the link does not answer 2xx', async () => {
    const r = await start(['--list', `http://127.0.0.1:${port}/missing`, '--db', path.join(dir, 'm.seoproject')]).done;
    expect(r.code).toBe(2);
    expect(r.err).toContain('HTTP 404');
  });
});
