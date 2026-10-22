import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPENSIVE_ISSUE_DEFINITIONS, ProjectDb } from '@freecrawl/db';

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
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

type Exit = { code: number | null; signal: NodeJS.Signals | null; out: string; err: string };

function start(args: string[]): { child: ChildProcess; done: Promise<Exit> } {
  const child = spawn(process.execPath, [CLI, base, '--concurrency', '2', '--no-robots', ...args]);
  let out = '';
  let err = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (err += d));
  const done = new Promise<Exit>((r) =>
    child.on('exit', (code, signal) => r({ code, signal, out, err })),
  );
  return { child, done };
}

async function untilCrawled(db: string, n: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
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
  }, 60000);

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
  }, 60000);

  it('--stop-file does the same soft stop and is removed afterwards', async () => {
    const db = path.join(dir, 'file.seoproject');
    const stopFile = path.join(dir, 'STOP');
    const { done } = start(['--json', '--db', db, '--stop-file', stopFile]);
    await untilCrawled(db, 5);
    fs.writeFileSync(stopFile, '');
    const r = await done;
    checkStopped(db, r);
    expect(fs.existsSync(stopFile)).toBe(false);
  }, 60000);

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
  }, 60000);

  it('a stop file already there at start is a usage error, no project created', async () => {
    const db = path.join(dir, 'pre.seoproject');
    const stopFile = path.join(dir, 'STOP');
    fs.writeFileSync(stopFile, '');
    const { done } = start(['--db', db, '--stop-file', stopFile]);
    const r = await done;
    expect(r.code).toBe(2);
    expect(r.err).toContain('already exists');
    expect(fs.existsSync(db)).toBe(false);
  }, 30000);
});
