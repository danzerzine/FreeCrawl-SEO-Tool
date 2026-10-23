import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { mergeCrawlConfig } from './crawl-config.js';

const start = { url: 'https://example.com/' };

describe('B44 CLI --coverage: config merge', () => {
  it('with rendering on it sets jsRender.coverage, off by default', () => {
    const on = mergeCrawlConfig({ renderingMode: 'js' }, { jsRender: { coverage: true } } as never, start);
    const off = mergeCrawlConfig({ renderingMode: 'js' }, {}, start);
    if (on.kind !== 'ok' || off.kind !== 'ok') throw new Error('expected ok');
    expect(on.config.jsRender.coverage).toBe(true);
    expect(off.config.jsRender.coverage).toBe(false);
  });

  it('coverage in a --config file with renderingMode js is kept', () => {
    const m = mergeCrawlConfig({ renderingMode: 'js', jsRender: { coverage: true } }, {}, start);
    if (m.kind !== 'ok') throw new Error('expected ok');
    expect(m.config.jsRender.coverage).toBe(true);
  });

  it('without rendering it is an error', () => {
    const m = mergeCrawlConfig({}, { jsRender: { coverage: true } } as never, start);
    expect(m).toEqual({ kind: 'error', message: '--coverage needs --render' });
  });
});

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
let dir: string;
let site: http.Server;
let base: string;
const CSS = `.used{color:red}${'.never{color:blue}'.repeat(60)}`;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b44c-'));
  site = http.createServer((req, res) => {
    if (req.url === '/s.css') return void res.writeHead(200, { 'content-type': 'text/css' }).end(CSS);
    if (req.url !== '/') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      '<!doctype html><html><head><title>T</title><link rel="stylesheet" href="/s.css"></head><body><p class="used">x</p></body></html>',
    );
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});
afterEach(async () => {
  await new Promise((r) => site.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

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
const db = () => path.join(dir, 'p.seoproject');

describe('B44 CLI --coverage: as a process', () => {
  it('--help lists --coverage', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/--coverage\s+With --render: measure how much CSS and JavaScript of each page is unused after load/);
    expect(r.out).toContain('Slows rendering');
  });

  it('--coverage without --render: exit 2 with the message', async () => {
    const r = await run([base, '--db', db(), '--max', '1', '--coverage']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--coverage needs --render');
  }, 60_000);

  it('--coverage with renderingMode js in --config is accepted', async () => {
    const cfg = path.join(dir, 'c.json');
    fs.writeFileSync(cfg, JSON.stringify({ renderingMode: 'js' }));
    const r = await run([base, '--db', db(), '--max', '1', '--config', cfg, '--coverage']);
    if (r.code === 2 && /Chromium/.test(r.err)) return void console.warn('SKIPPED: Chromium is not installed');
    expect(r.code, r.err.slice(-600)).toBe(0);
  }, 90_000);

  it('--render --coverage stores the four numbers; the URL CSV carries them', async () => {
    const r = await run([base, '--db', db(), '--max', '1', '--render', '--coverage']);
    if (r.code === 2 && /Chromium/.test(r.err)) return void console.warn('SKIPPED: Chromium is not installed');
    expect(r.code, r.err.slice(-600)).toBe(0);
    const p = new ProjectDb(db());
    try {
      const row = p.getUrlById(p.getUrlIdByUrl(base)!)!;
      expect(row.cssBytes).toBe(CSS.length);
      expect(row.cssUnusedBytes).toBe(CSS.length - '.used{color:red}'.length);
      expect(row.jsBytes).toBe(0);
      expect(row.jsUnusedBytes).toBe(0);
    } finally {
      p.close();
    }
    const out = path.join(dir, 'out');
    const ex = await run(['export', '--project', db(), '--what', 'bulk', '--out', out]);
    expect(ex.code, ex.err.slice(-600)).toBe(0);
    const urls = fs.readdirSync(out).find((f) => /^urls|internal/i.test(f) && f.endsWith('.csv'));
    expect(urls).toBeTruthy();
    const lines = fs.readFileSync(path.join(out, urls!), 'utf8').replace(/^\uFEFF/, '').split('\n');
    const head = lines[0]!.split(',');
    expect(head).toEqual(expect.arrayContaining(['CSS Bytes', 'Unused CSS Bytes', 'JS Bytes', 'Unused JS Bytes']));
  }, 120_000);
});
