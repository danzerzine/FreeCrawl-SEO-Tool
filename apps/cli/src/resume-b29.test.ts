import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';

// Drives the built CLI as a process (`npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

let dir: string;
let site: http.Server;
let other: http.Server;
let base: string;
let otherBase: string;
/** GET requests to the site, by path. */
let gets: string[] = [];
let pages = 120;
let delayMs = 50;
let rootRedirects = false;
/** Requests to the other server (the external link checks). */
let externalHits = 0;

// A finite tree: page i links to 3i+1..3i+3 below `pages`, and to one page
// on another server (an external link).
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b29-'));
  gets = [];
  pages = 120;
  delayMs = 50;
  rootRedirects = false;
  externalHits = 0;
  other = http.createServer((_req, res) => (externalHits++, res).writeHead(200, { 'content-type': 'text/html' }).end('<html></html>'));
  // Another host name: the crawl tells sites apart by host, not port.
  await new Promise<void>((r) => other.listen(0, r));
  otherBase = `http://localhost:${(other.address() as AddressInfo).port}/`;
  site = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET') gets.push(url);
    if (url === '/robots.txt' || url.startsWith('/sitemap')) return void res.writeHead(404).end();
    if (url === '/' && rootRedirects) return void res.writeHead(301, { location: '/p/1' }).end();
    const m = /^\/p\/(\d+)$/.exec(url);
    const i = m ? Number(m[1]) : 0;
    const links = [1, 2, 3].map((k) => i * 3 + k).filter((n) => n < pages).map((n) => `<a href="/p/${n}">x</a>`);
    links.push(`<a href="${otherBase}x${i}">ext</a>`);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head><title>p${i}</title></head><body>${links.join('')}</body></html>`);
    }, delayMs);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});

afterEach(async () => {
  await new Promise((r) => site.close(r));
  await new Promise((r) => other.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

type Exit = { code: number | null; signal: NodeJS.Signals | null; out: string; err: string };

function start(args: string[]): { child: ChildProcess; done: Promise<Exit> } {
  const child = spawn(process.execPath, [CLI, ...args, '--concurrency', '2', '--no-robots']);
  let out = '';
  let err = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (err += d));
  const done = new Promise<Exit>((r) => child.on('exit', (code, signal) => r({ code, signal, out, err })));
  return { child, done };
}

const run = (args: string[]) => start(args).done;

function read<T>(db: string, f: (p: ProjectDb) => T): T {
  const p = new ProjectDb(db, { readOnly: true });
  try {
    return f(p);
  } finally {
    p.close();
  }
}

const fetched = (db: string) => read(db, (p) => p.getCrawledInternalUrls().map((r) => r.url));

async function untilCrawled(db: string, n: number, limitMs = 20000): Promise<void> {
  for (const t0 = Date.now(); Date.now() - t0 < limitMs; ) {
    await new Promise((r) => setTimeout(r, 100));
    if (!fs.existsSync(db)) continue;
    try {
      if (read(db, (p) => p.countCrawledUrls()) >= n) return;
    } catch {
      /* not created yet */
    }
  }
  throw new Error(`crawl never reached ${n} pages`);
}

/** Starts a crawl, stops it softly after `n` pages; returns what it fetched. */
async function stopAfter(db: string, n: number, extra: string[] = []): Promise<string[]> {
  const { child, done } = start([...extra, '--db', db]);
  await untilCrawled(db, n);
  child.kill('SIGINT');
  expect((await done).code).toBe(130);
  return fetched(db);
}

function refetched(before: string[]): string[] {
  const seen = new Set(before);
  return gets.map((g) => new URL(g, base).toString()).filter((u) => seen.has(u));
}

describe('--resume (B29)', () => {
  it('continues a softly stopped crawl: nothing fetched twice, same pages as a full crawl, queue cleared', async () => {
    const db = path.join(dir, 'soft.seoproject');
    const before = await stopAfter(db, 15, [base]);
    expect(before.length).toBeLessThan(pages);
    gets = [];
    const r = await run([base, '--resume', '--db', db]);
    expect(r.code).toBe(0);
    expect(refetched(before)).toEqual([]);
    // The same pages as an uninterrupted crawl: / and /p/1../p/<pages-1>.
    const all = [base, ...Array.from({ length: pages - 1 }, (_, i) => `${base}p/${i + 1}`)];
    expect(fetched(db).sort()).toEqual(all.sort());
    // A complete crawl leaves nothing to resume.
    expect(read(db, (p) => p.loadQueueCheckpoint())).toEqual([]);
  }, 60000);

  it('after kill -9 past a checkpoint write, the saved queue holds fetched pages and none is fetched again', async () => {
    pages = 400;
    const db = path.join(dir, 'kill.seoproject');
    const { child, done } = start([base, '--rps', '5', '--db', db]);
    // Past two 30-second checkpoint writes.
    await new Promise((r) => setTimeout(r, 65000));
    child.kill('SIGKILL');
    await done;
    const before = fetched(db);
    const { saved, unfetched } = read(db, (p) => ({
      saved: p.loadQueueCheckpoint().length,
      unfetched: p.loadUnfetchedQueueCheckpoint().length,
    }));
    // Otherwise the test proves nothing: the stale rows are the case.
    expect(saved).toBeGreaterThan(unfetched);
    gets = [];
    const r = await run([base, '--resume', '--db', db]);
    expect([0, 1]).toContain(r.code);
    expect(refetched(before)).toEqual([]);
    expect(fetched(db)).toHaveLength(pages);
  }, 180000);

  it('list mode: continues the same list without fetching a line twice', async () => {
    delayMs = 100;
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, Array.from({ length: 40 }, (_, i) => `${base}p/${i}`).join('\n'));
    const db = path.join(dir, 'list.seoproject');
    const before = await stopAfter(db, 8, ['--list', list, '--no-check-external']);
    gets = [];
    const r = await run(['--list', list, '--resume', '--no-check-external', '--db', db]);
    expect(r.code).toBe(0);
    expect(refetched(before)).toEqual([]);
    expect(fetched(db)).toHaveLength(40);
  }, 60000);

  it('list mode: a line saved in the queue with a row but no answer yet is fetched on resume', async () => {
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, Array.from({ length: 20 }, (_, i) => `${base}p/${i}`).join('\n'));
    const db = path.join(dir, 'stub.seoproject');
    const before = await stopAfter(db, 8, ['--list', list, '--no-check-external']);
    // As a kill leaves a line that was being fetched: a row with no status,
    // and the line in the saved queue. The list sweep marks every known row
    // as done, so only the saved queue brings it back.
    const stub = before[0]!;
    const raw = new DatabaseSync(db);
    raw.prepare('UPDATE urls SET status_code = NULL WHERE url = ?').run(stub);
    raw.prepare('INSERT OR REPLACE INTO crawl_queue (url, depth, seed_url) VALUES (?, 0, NULL)').run(stub);
    raw.close();
    gets = [];
    const r = await run(['--list', list, '--resume', '--no-check-external', '--db', db]);
    expect(r.code).toBe(0);
    expect(refetched(before)).toEqual([stub]);
    expect(fetched(db)).toHaveLength(20);
  }, 60000);

  it('refuses another site or another kind of crawl and leaves the file as it was', async () => {
    const db = path.join(dir, 'other.seoproject');
    await stopAfter(db, 5, [base]);
    const bytes = fs.readFileSync(db);
    const host = await run([base.replace('127.0.0.1', 'localhost'), '--resume', '--db', db]);
    expect(host.code).toBe(2);
    expect(host.err).toContain('--resume continues it');
    const list = path.join(dir, 'l.txt');
    fs.writeFileSync(list, `${base}p/1\n`);
    const mode = await run(['--list', list, '--resume', '--db', db]);
    expect(mode.code).toBe(2);
    expect(fs.readFileSync(db).equals(bytes)).toBe(true);
  }, 60000);

  it('keeps every page when the start URL now redirects elsewhere', async () => {
    const db = path.join(dir, 'moved.seoproject');
    const before = await stopAfter(db, 15, [base]);
    rootRedirects = true;
    const r = await run([base, '--resume', '--db', db]);
    expect(r.err).toContain('the resumed crawl keeps');
    const after = fetched(db);
    for (const u of before) expect(after).toContain(u);
    expect(after.length).toBeGreaterThan(before.length);
  }, 60000);

  it('without --resume, says the pages are fetched again or the project replaced', async () => {
    const db = path.join(dir, 'warn.seoproject');
    expect((await run([base, '--max', '10', '--db', db])).code).toBe(0);
    const again = await run([base, '--max', '10', '--db', db]);
    expect(again.err).toMatch(/\d+ pages already in .*; all of them are fetched again\. To continue an interrupted crawl, add --resume\./);
    const replaced = await run([otherBase, '--max', '2', '--db', db]);
    expect(replaced.err).toContain('is replaced by this one');
  }, 60000);

  it('--resume on a new project crawls and says there was nothing to resume', async () => {
    const r = await run([base, '--max', '5', '--resume', '--db', path.join(dir, 'new.seoproject')]);
    expect(r.code).toBe(0);
    expect(r.err).toContain('Nothing to resume');
  }, 30000);

  it('--max on a resume counts pages, not the external links already known', async () => {
    const db = path.join(dir, 'max.seoproject');
    await stopAfter(db, 10, [base, '--max', '30']);
    expect(read(db, (p) => p.getUrlsByScope(true).length)).toBeGreaterThan(0);
    const r = await run([base, '--max', '30', '--resume', '--db', db]);
    expect([0, 1]).toContain(r.code);
    expect(fetched(db)).toHaveLength(30);
  }, 60000);

  it('a second crawl into a project in use exits 2', async () => {
    delayMs = 300;
    const db = path.join(dir, 'busy.seoproject');
    const first = start([base, '--db', db]);
    await untilCrawled(db, 2);
    // Taken while the first crawl is between writes; the second must not
    // touch the file at all.
    const stat = fs.statSync(db);
    const second = await run([base, '--db', db]);
    expect(second.code).toBe(2);
    expect(second.err).toContain('in use');
    expect(fs.existsSync(`${db}.lock`)).toBe(true);
    expect(fs.statSync(db).ino).toBe(stat.ino);
    first.child.kill('SIGINT');
    expect((await first.done).code).toBe(130);
  }, 60000);

  it('a refresh and a resume still check the external links already known', async () => {
    const db = path.join(dir, 'ext.seoproject');
    expect((await run([base, '--max', '10', '--db', db])).code).toBe(0);
    const first = externalHits;
    expect(first).toBeGreaterThan(0);
    externalHits = 0;
    await run([base, '--max', '10', '--db', db]);
    expect(externalHits).toBe(first);
  }, 60000);

  it('--resume --json: the note is a JSON line', async () => {
    const r = await run([base, '--max', '3', '--resume', '--json', '--db', path.join(dir, 'j.seoproject')]);
    const lines = r.err.split('\n').filter((l) => l.trim() !== '');
    for (const l of lines) expect(() => JSON.parse(l), l).not.toThrow();
    expect(r.err).toContain('Nothing to resume');
  }, 30000);
});
