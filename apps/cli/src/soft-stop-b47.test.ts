import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPENSIVE_ISSUE_DEFINITIONS, ProjectDb } from '@freecrawl/db';
import { killAllChildren, spawnTracked as spawn } from './test-proc.js';

// Drives the built CLI as a process (`npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

let dir: string;
let server: http.Server;
let base: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b47-'));
  // A site far bigger than the test lets the crawl get through: each page
  // links three more, answered slowly.
  server = http.createServer((req, res) => {
    if (req.url === '/robots.txt' || req.url?.startsWith('/sitemap')) return void res.writeHead(404).end();
    const m = /^\/p\/(\d+)$/.exec(req.url ?? '');
    const i = m ? Number(m[1]) : 0;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<html><head><title>p${i}</title></head><body>` +
          [1, 2, 3].map((k) => `<a href="/p/${i * 3 + k}">x</a>`).join('') +
          '</body></html>',
      );
    }, 150);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterEach(async () => {
  killAllChildren();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

type Exit = { code: number | null; signal: NodeJS.Signals | null; out: string; err: string };

function start(args: string[]): { child: ChildProcessWithoutNullStreams; done: Promise<Exit> } {
  const child = spawn(process.execPath, [CLI, base, '--concurrency', '2', '--no-robots', ...args]);
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise<Exit>((r) =>
    child.on('exit', (code, signal) => r({ code, signal, out, err })),
  );
  return { child, done };
}

async function untilCrawled(db: string, n: number): Promise<void> {
  // Poll until the crawl has saved n pages; the ceiling (120 s) only matters if it never does.
  for (let i = 0; i < 1200; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!fs.existsSync(db)) continue;
    try {
      const p = new ProjectDb(db, { readOnly: true });
      const total = p.getSummary().total;
      p.close();
      if (total >= n) return;
    } catch {
      /* not created yet */
    }
  }
  throw new Error(`crawl never reached ${n} pages`);
}

function checkStopped(db: string, r: { code: number | null; out: string }): void {
  expect(r.code).toBe(130);
  const doc = JSON.parse(r.out);
  expect(doc).toMatchObject({ interrupted: true, complete: false });
  expect(doc.summary.total).toBeGreaterThan(0);
  // The journal is folded into the database before exit.
  const wal = `${db}-wal`;
  expect(!fs.existsSync(wal) || fs.statSync(wal).size === 0).toBe(true);
  const p = new ProjectDb(db, { readOnly: true });
  try {
    // What was still to fetch is saved for --resume.
    expect(p.loadQueueCheckpoint().length).toBeGreaterThan(0);
  } finally {
    p.close();
  }
  // The issue counts were brought up to date before the summary: a recount
  // of a copy changes nothing.
  const copy = `${db}.copy`;
  fs.copyFileSync(db, copy);
  const c = new ProjectDb(copy);
  try {
    const before = c.getOverviewCounts().issues;
    c.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    expect(c.getOverviewCounts().issues).toEqual(before);
  } finally {
    c.close();
  }
}

describe('soft stop (B47)', () => {
  it('SIGINT stops the crawl, prints the --json summary and exits 130', async () => {
    const db = path.join(dir, 'int.seoproject');
    const { child, done } = start(['--json', '--db', db]);
    await untilCrawled(db, 5);
    child.kill('SIGINT');
    const r = await done;
    expect(r.err).toContain('Stopping');
    checkStopped(db, r);
  }, 180000);

  it('a second SIGINT kills the process at once', async () => {
    const db = path.join(dir, 'twice.seoproject');
    const { child, done } = start(['--json', '--db', db]);
    await untilCrawled(db, 5);
    child.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    child.kill('SIGINT');
    const r = await done;
    // No handler is left after the first signal: the default action ends
    // the process, which a shell reports as 130.
    expect(r.signal).toBe('SIGINT');
    expect(Date.now() - t0).toBeLessThan(2000);
  }, 180000);

  it('--stop-file does the same soft stop and is removed afterwards', async () => {
    const db = path.join(dir, 'file.seoproject');
    const stopFile = path.join(dir, 'STOP');
    const { done } = start(['--json', '--db', db, '--stop-file', stopFile]);
    await untilCrawled(db, 5);
    fs.writeFileSync(stopFile, '');
    const r = await done;
    checkStopped(db, r);
    expect(fs.existsSync(stopFile)).toBe(false);
  }, 180000);

  it('a stopped crawl writes no export and says so', async () => {
    const db = path.join(dir, 'exp.seoproject');
    const out = path.join(dir, 'out');
    const { child, done } = start(['--json', '--db', db, '--export-dir', out]);
    await untilCrawled(db, 5);
    child.kill('SIGINT');
    const r = await done;
    expect(r.code).toBe(130);
    expect(r.err).toContain('export and compare skipped');
    expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toEqual([]);
  }, 180000);

  it('a stopped refresh says that --resume finishes only new pages', async () => {
    const db = path.join(dir, 'refresh.seoproject');
    expect((await start(['--max', '5', '--db', db]).done).code).toBe(0);
    // The same site again without --resume: every known page is fetched again.
    const { child, done } = start(['--db', db]);
    child.stderr.on('data', (d) => {
      if (String(d).includes('fetched again')) setTimeout(() => child.kill('SIGINT'), 500);
    });
    const r = await done;
    expect(r.code).toBe(130);
    const stopping = r.err.indexOf('Stopping');
    expect(stopping).toBeGreaterThan(-1);
    expect(r.err.indexOf('This was a refresh: --resume finishes only new pages')).toBeGreaterThan(stopping);
  }, 180000);

  it('Ctrl-C while a finished crawl recounts its checks does not stop it', async () => {
    // Two pages, each with an image answered slowly: the image-size probe
    // after the crawl holds the end-of-crawl passes open for the signal.
    const site = http.createServer((req, res) => {
      if (req.url === '/slow.png') {
        return void setTimeout(() => res.writeHead(200, { 'content-type': 'image/png' }).end(), 3000);
      }
      if (req.url !== '/' && req.url !== '/a') return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>t</title></head><body><a href="/a">a</a><img src="/slow.png"></body></html>');
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    try {
      const db = path.join(dir, 'finishing.seoproject');
      const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
      const child = spawn(process.execPath, [CLI, url, '--no-robots', '--json', '--verbose', '--db', db]);
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => {
        err += d;
        if (String(d).includes('Probing')) child.kill('SIGINT');
      });
      const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
      expect(err).toContain('Probing');
      expect(err).toContain('The crawl has finished; recounting issues.');
      expect(err).not.toContain('Stopping');
      expect(code).toBe(0);
      expect(JSON.parse(out)).toMatchObject({ interrupted: false, complete: true });
      const p = new ProjectDb(db, { readOnly: true });
      try {
        // The run is in the history, as for any finished crawl.
        expect(p.listCrawlRuns(url).length).toBe(1);
      } finally {
        p.close();
      }
    } finally {
      await new Promise((r) => site.close(r));
    }
  }, 180000);

  it('a stop file already there at start is a usage error, no project created', async () => {
    const db = path.join(dir, 'pre.seoproject');
    const stopFile = path.join(dir, 'STOP');
    fs.writeFileSync(stopFile, '');
    const { done } = start(['--db', db, '--stop-file', stopFile]);
    const r = await done;
    expect(r.code).toBe(2);
    expect(r.err).toContain('already exists');
    expect(fs.existsSync(db)).toBe(false);
  }, 120000);
});
