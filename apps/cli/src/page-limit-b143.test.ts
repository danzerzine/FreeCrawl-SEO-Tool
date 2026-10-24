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
let base: string;

// A chain of 20 pages, each linking the next, so a stopped crawl saves a
// short queue; /p/1 also links five URLs that robots.txt disallows
// (robots.txt is read by the time it is parsed).
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b143-'));
  site = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/robots.txt') {
      return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /blocked/\n');
    }
    if (url.startsWith('/sitemap')) return void res.writeHead(404).end();
    const m = /^\/p\/(\d+)$/.exec(url);
    const i = m ? Number(m[1]) : 0;
    const links = i + 1 < 20 ? [`<a href="/p/${i + 1}">x</a>`] : [];
    if (i === 1) for (let b = 1; b <= 5; b++) links.unshift(`<a href="/blocked/${b}">b</a>`);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head><title>p${i}</title></head><body>${links.join('')}</body></html>`);
    }, 100);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});

afterEach(async () => {
  await new Promise((r) => site.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

type Exit = { code: number | null; out: string; err: string };

function start(args: string[]): { child: ChildProcess; done: Promise<Exit> } {
  const child = spawn(process.execPath, [CLI, base, '--concurrency', '2', ...args]);
  let out = '';
  let err = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (err += d));
  const done = new Promise<Exit>((r) => child.on('exit', (code) => r({ code, out, err })));
  return { child, done };
}

function counts(db: string): { fetched: number; blocked: number } {
  const raw = new DatabaseSync(db, { readOnly: true });
  try {
    const one = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
    return {
      fetched: one('SELECT COUNT(*) AS n FROM urls WHERE is_external = 0 AND status_code IS NOT NULL'),
      blocked: one(
        "SELECT COUNT(*) AS n FROM urls WHERE is_external = 0 AND indexability = 'non-indexable:robots-blocked'",
      ),
    };
  } finally {
    raw.close();
  }
}

describe('--max counts pages, not robots-blocked URLs (B143)', () => {
  it('fetches --max pages besides the blocked ones and says it stopped at the limit', async () => {
    const db = path.join(dir, 'max.seoproject');
    const r = await start(['--max', '10', '--db', db]).done;
    expect(r.code).toBe(0);
    expect(counts(db)).toEqual({ fetched: 10, blocked: 5 });
    expect(r.out).toContain('Stopped at the page limit (10).');
  }, 60000);

  it('a resumed crawl counts the same way', async () => {
    const db = path.join(dir, 'resume.seoproject');
    const { child, done } = start(['--max', '10', '--db', db]);
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        const c = counts(db);
        if (c.fetched >= 3 && c.blocked === 5) break;
      } catch {
        /* not created yet */
      }
    }
    child.kill('SIGINT');
    expect((await done).code).toBe(130);
    expect(counts(db).fetched).toBeLessThan(10);
    const r = await start(['--max', '10', '--resume', '--db', db]).done;
    expect(r.code).toBe(0);
    expect(counts(db)).toEqual({ fetched: 10, blocked: 5 });
  }, 60000);

  it('a resume that ignores robots.txt does not go past --max with the URLs it had blocked', async () => {
    const db = path.join(dir, 'ignore.seoproject');
    const first = await start(['--max', '10', '--db', db]).done;
    expect(first.code).toBe(0);
    expect(counts(db)).toEqual({ fetched: 10, blocked: 5 });
    const r = await start(['--max', '10', '--resume', '--no-robots', '--db', db]).done;
    expect(r.code).toBe(0);
    expect(counts(db).fetched).toBe(10);
  }, 60000);
});
