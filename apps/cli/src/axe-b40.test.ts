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

describe('B40 CLI --axe: config merge', () => {
  it('--axe with rendering on sets jsRender.axeAudit and adds no note', () => {
    const m = mergeCrawlConfig({ renderingMode: 'js' }, { jsRender: { axeAudit: true } } as never, start);
    if (m.kind !== 'ok') throw new Error('expected ok');
    expect(m.config.jsRender.axeAudit).toBe(true);
    expect(m.notes).toEqual([]);
  });

  it('axeAudit in a --config file is kept and is off by default', () => {
    const on = mergeCrawlConfig({ renderingMode: 'js', jsRender: { axeAudit: true } }, {}, start);
    const off = mergeCrawlConfig({ renderingMode: 'js' }, {}, start);
    if (on.kind !== 'ok' || off.kind !== 'ok') throw new Error('expected ok');
    expect(on.config.jsRender.axeAudit).toBe(true);
    expect(off.config.jsRender.axeAudit).toBe(false);
  });

  it('--axe without rendering is one note and has no effect', () => {
    const m = mergeCrawlConfig({}, { jsRender: { axeAudit: true } } as never, start);
    if (m.kind !== 'ok') throw new Error('expected ok');
    expect(m.config.jsRender.axeAudit).toBe(false);
    expect(m.notes).toHaveLength(1);
    expect(m.notes[0]).toMatch(/--axe.*--render/);
  });
});

// Process-level: drives the built CLI (`npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
let dir: string;
let site: http.Server;
let base: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b40c-'));
  site = http.createServer((req, res) => {
    if (req.url !== '/') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      '<!doctype html><html lang="en"><head><title>T</title></head><body><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><button></button></body></html>',
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

describe('B40 CLI --axe: as a process', () => {
  it('--help lists --axe and the axe-violations dataset', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/--axe\s+With --render/);
    expect(r.out).toContain('axe-violations');
  });

  it('--axe without --render: note line, normal crawl, exit 0, nothing audited', async () => {
    const r = await run([base, '--db', db(), '--max', '1', '--axe']);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/--axe.*--render/);
    const p = new ProjectDb(db());
    try {
      expect(p.getUrlById(p.getUrlIdByUrl(base)!)!.axeViolations).toBeNull();
    } finally {
      p.close();
    }
  }, 60_000);

  it('without --verbose the axe cost line is not printed (B175)', async () => {
    const r = await run([base, '--db', db(), '--max', '1', '--render', '--axe']);
    if (r.code === 2 && /Chromium/.test(r.err)) {
      console.warn('SKIPPED: Chromium is not installed');
      return;
    }
    expect(r.code).toBe(0);
    expect(r.err + r.out).not.toMatch(/axe-core: \d+ pages?/);
    const p = new ProjectDb(db());
    try {
      expect(p.getUrlById(p.getUrlIdByUrl(base)!)!.axeViolations).toBeGreaterThanOrEqual(2);
    } finally {
      p.close();
    }
  }, 90_000);

  it('--render --axe stores the audit, prints the cost line, and the dataset exports', async () => {
    const r = await run([base, '--db', db(), '--max', '1', '--render', '--axe', '--verbose']);
    if (r.code === 2 && /Chromium/.test(r.err)) {
      console.warn('SKIPPED: Chromium is not installed');
      return;
    }
    expect(r.code).toBe(0);
    expect(r.err + r.out).toMatch(/axe-core: 1 pages?, avg \d+ ms, 0 failed/);
    const p = new ProjectDb(db());
    try {
      const row = p.getUrlById(p.getUrlIdByUrl(base)!)!;
      expect(row.axeViolations).toBeGreaterThanOrEqual(2);
      expect(row.axeSerious).toBeGreaterThanOrEqual(2);
      expect(p.queryAxe({ limit: 50, offset: 0 }).rows.map((x) => x.ruleId)).toEqual(
        expect.arrayContaining(['image-alt', 'button-name']),
      );
    } finally {
      p.close();
    }
    const out = path.join(dir, 'out');
    const ex = await run(['export', '--project', db(), '--what', 'dataset:axe-violations', '--out', out]);
    expect(ex.code).toBe(0);
    const csv = fs.readFileSync(path.join(out, 'axe-violations.csv'), 'utf8');
    expect(csv.split('\n')[0]).toContain('URL,Rule,Kind,Impact');
    expect(csv).toContain('image-alt');
  }, 90_000);
});
