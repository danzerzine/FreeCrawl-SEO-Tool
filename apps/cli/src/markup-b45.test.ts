import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { mergeCrawlConfig } from './crawl-config.js';

const start = { url: 'https://example.com/' };

describe('B45 CLI --markup-check: config merge', () => {
  it('the flag sets markupValidation; a --config file keeps it; off by default', () => {
    const flag = mergeCrawlConfig({}, { markupValidation: true }, start);
    const file = mergeCrawlConfig({ markupValidation: true }, {}, start);
    const off = mergeCrawlConfig({}, {}, start);
    if (flag.kind !== 'ok' || file.kind !== 'ok' || off.kind !== 'ok') throw new Error('expected ok');
    expect(flag.config.markupValidation).toBe(true);
    expect(file.config.markupValidation).toBe(true);
    expect(off.config.markupValidation).toBe(false);
    expect(flag.notes).toEqual([]);
  });
});

// Process-level: drives the built CLI (`npx tsc -b && npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
let dir: string;
let site: http.Server;
let base: string;

const PAGES: Record<string, string> = {
  '/': '<!DOCTYPE html><html><head><title>Home</title></head><body><a href="/dup">d</a><a href="/nodoc">n</a></body></html>',
  '/dup': '<!DOCTYPE html><html><head><title>Dup</title></head><body><p id="x">a</p><p id="x">b</p></body></html>',
  '/nodoc': '<html><head><title>No doctype</title></head><body><p>x</p></body></html>',
};
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b45cli-'));
  site = http.createServer((req, res) => {
    const body = PAGES[req.url ?? '/'];
    res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html' }).end(body ?? '');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  await new Promise((r) => site.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

// Async: the fixture server lives in this process, so it must keep serving.
function run(args: string[]) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: process.env });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('exit', (code) => resolve({ code, out, err }));
  });
}

const markupColumns = (file: string): [string, number | null, string | null][] => {
  const p = new ProjectDb(file);
  try {
    return [...p.iterateUrlsByCategory('internal:html')]
      .map((r) => [r.url.replace(base, '/'), r.markupErrors, r.markupCodes] as [string, number | null, string | null])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  } finally {
    p.close();
  }
};

describe('B45 CLI --markup-check: as a process', () => {
  it('--help carries the flag line', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out.replace(/\s+/g, ' ')).toContain(
      '--markup-check Count HTML markup errors per page (missing doctype, duplicate id, broken tags, unclosed elements…). With --render the HTML the server sent is checked. Parses every page twice more',
    );
  });

  it('crawl with the flag, then export --what issues:markup-errors lists exactly the failing URLs', async () => {
    const db = path.join(dir, 'pool.seoproject');
    const c = await run([base, '--no-robots', '--db', db]);
    expect(c.code, c.err).toBe(0);
    expect(markupColumns(db)).toEqual([
      ['/', null, null],
      ['/dup', null, null],
      ['/nodoc', null, null],
    ]);
    const on = path.join(dir, 'on.seoproject');
    const r = await run([base, '--no-robots', '--markup-check', '--db', on]);
    expect(r.code, r.err).toBe(0);
    expect(markupColumns(on)).toEqual([
      ['/', 0, null],
      ['/dup', 1, '{"duplicate-id":1}'],
      ['/nodoc', 1, '{"missing-doctype":1}'],
    ]);
    const out = path.join(dir, 'out');
    const ex = await run(['export', '--project', on, '--what', 'issues:markup-errors', '--out', out]);
    expect(ex.code, ex.err).toBe(0);
    const lines = fs.readFileSync(path.join(out, 'issues-markup-errors.csv'), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines.slice(1).map((l) => l.split(',')[0]!.replace(base, '/')).sort()).toEqual(['/dup', '/nodoc']);
    expect(lines[0]).toContain('Markup Errors,Markup Error Codes');
  }, 120_000);

  it('--parse-workers 0 (inline) gives the same numbers as the worker pool', async () => {
    const inline = path.join(dir, 'inline.seoproject');
    const pool = path.join(dir, 'pool2.seoproject');
    const a = await run([base, '--no-robots', '--markup-check', '--parse-workers', '0', '--db', inline]);
    const b = await run([base, '--no-robots', '--markup-check', '--parse-workers', '2', '--db', pool]);
    expect(a.code, a.err).toBe(0);
    expect(b.code, b.err).toBe(0);
    expect(markupColumns(inline)).toEqual(markupColumns(pool));
    expect(markupColumns(pool).map((r) => r[1])).toEqual([0, 1, 1]);
  }, 120_000);
});
