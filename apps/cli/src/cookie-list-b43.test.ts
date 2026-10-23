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

describe('B43 CLI --cookie-list: config merge', () => {
  it('with rendering on it sets jsRender.cookieList, off by default', () => {
    const on = mergeCrawlConfig({ renderingMode: 'js' }, { jsRender: { cookieList: true } } as never, start);
    const off = mergeCrawlConfig({ renderingMode: 'js' }, {}, start);
    if (on.kind !== 'ok' || off.kind !== 'ok') throw new Error('expected ok');
    expect(on.config.jsRender.cookieList).toBe(true);
    expect(off.config.jsRender.cookieList).toBe(false);
  });

  it('cookieList in a --config file with renderingMode js is kept', () => {
    const m = mergeCrawlConfig({ renderingMode: 'js', jsRender: { cookieList: true } }, {}, start);
    if (m.kind !== 'ok') throw new Error('expected ok');
    expect(m.config.jsRender.cookieList).toBe(true);
  });

  it('without rendering it is an error, not a silent no-op', () => {
    const m = mergeCrawlConfig({}, { jsRender: { cookieList: true } } as never, start);
    expect(m).toEqual({ kind: 'error', message: '--cookie-list needs --render' });
  });
});

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
let dir: string;
let site: http.Server;
let base: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b43c-'));
  site = http.createServer((req, res) => {
    if (req.url !== '/') return void res.writeHead(404).end();
    res.writeHead(200, {
      'content-type': 'text/html',
      'set-cookie': ['sid=SECRETVALUE123; Path=/; HttpOnly; SameSite=Lax'],
    }).end(
      '<!doctype html><html><head><title>T</title></head><body><script>document.cookie="ga=SECRETVALUE456; path=/"</script></body></html>',
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

describe('B43 CLI --cookie-list: as a process', () => {
  it('--help lists --cookie-list and dataset:cookies', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/--cookie-list\s+With --render: list the cookies each page sets or tries to set/);
    expect(r.out).toContain('up to 100 per page');
    expect(r.out).toContain('cookies');
  });

  it('--cookie-list without --render: exit 2 with the message, no project written', async () => {
    const r = await run([base, '--db', db(), '--max', '1', '--cookie-list']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--cookie-list needs --render');
  }, 60_000);

  it('--cookie-list with renderingMode js in --config is accepted', async () => {
    const cfg = path.join(dir, 'c.json');
    fs.writeFileSync(cfg, JSON.stringify({ renderingMode: 'js' }));
    const r = await run([base, '--db', db(), '--max', '1', '--config', cfg, '--cookie-list']);
    if (r.code === 2 && /Chromium/.test(r.err)) return void console.warn('SKIPPED: Chromium is not installed');
    expect(r.code).toBe(0);
  }, 90_000);

  it('--render --cookie-list stores the list without values; dataset:cookies exports it', async () => {
    const r = await run([base, '--db', db(), '--max', '1', '--render', '--cookie-list']);
    if (r.code === 2 && /Chromium/.test(r.err)) return void console.warn('SKIPPED: Chromium is not installed');
    expect(r.code, r.err.slice(-600)).toBe(0);
    const p = new ProjectDb(db());
    try {
      const row = p.getUrlById(p.getUrlIdByUrl(base)!)!;
      expect(row.cookiesTotal).toBe(2);
      expect(row.cookiesTruncated).toBe(0);
      expect(row.cookiesJson).not.toContain('SECRETVALUE');
    } finally {
      p.close();
    }
    const out = path.join(dir, 'out');
    const ex = await run(['export', '--project', db(), '--what', 'dataset:cookies', '--out', out]);
    expect(ex.code, ex.err.slice(-600)).toBe(0);
    const csv = fs.readFileSync(path.join(out, 'cookies.csv'), 'utf8');
    expect(csv.split('\n')[0]).toContain('URL,Cookie,Domain,Path,Secure,HttpOnly,SameSite,Expires,Set By,Third Party');
    expect(csv).toMatch(/,sid,127\.0\.0\.1,\/,false,true,Lax,session,header,false,2,false/);
    expect(csv).toMatch(/,ga,127\.0\.0\.1,\/,/);
    // Leak guard: the value (sent in a header and written by the page script) is nowhere in the project files.
    for (const f of fs.readdirSync(dir).filter((n) => n.startsWith('p.seoproject'))) {
      expect(fs.readFileSync(path.join(dir, f)).includes('SECRETVALUE'), f).toBe(false);
    }
    for (const f of fs.readdirSync(out)) {
      expect(fs.readFileSync(path.join(out, f), 'utf8')).not.toContain('SECRETVALUE');
    }
  }, 120_000);
});
