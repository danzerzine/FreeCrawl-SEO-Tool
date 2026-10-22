import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';

// Drives the built CLI (`npx tsc -b` and `npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
let dir: string;
let site: http.Server;
let base: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b34-'));
  site = http.createServer((req, res) => {
    if (req.url !== '/') return void res.writeHead(404).end();
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<html><head><title>T</title></head><body><h1>H</h1></body></html>');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});
afterEach(async () => {
  await new Promise((r) => site.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('exit', (code) => resolve({ code, out, err }));
  });
}
const script = (text: string) => {
  const f = path.join(dir, 's.js');
  fs.writeFileSync(f, text);
  return f;
};
const db = () => path.join(dir, 'p.seoproject');

it('--page-script without --render or renderingMode js exits 2 with one line', async () => {
  const r = await run([base, '--db', db(), '--max', '1', '--page-script', script('return 1')]);
  expect(r.code).toBe(2);
  expect(r.err.trim().split('\n')).toHaveLength(1);
  expect(r.err).toMatch(/--render/);
});

it('--page-script with an unreadable or empty file exits 2', async () => {
  const missing = await run([base, '--db', db(), '--render', '--page-script', path.join(dir, 'nope.js')]);
  expect(missing.code).toBe(2);
  const empty = await run([base, '--db', db(), '--render', '--page-script', script('  \n')]);
  expect(empty.code).toBe(2);
});

it('--page-script with --config js but no Chromium exits 2 (the script would silently not run)', async () => {
  const cfg = path.join(dir, 'c.json');
  fs.writeFileSync(cfg, JSON.stringify({ renderingMode: 'js' }));
  const r = await run(
    [base, '--db', db(), '--config', cfg, '--page-script', script('return 1')],
    { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(dir, 'no-browsers') },
  );
  expect(r.code).toBe(2);
});

it('--render --page-script runs the file on the page and stores the result under $script', async () => {
  const r = await run([base, '--db', db(), '--max', '1', '--render', '--page-script', script('return document.title + "!"')]);
  if (r.code === 2 && /Chromium/.test(r.err)) {
    console.warn('SKIPPED: Chromium is not installed');
    return;
  }
  expect(r.code).toBe(0);
  const p = new ProjectDb(db());
  try {
    const row = p.getUrlById(p.getUrlIdByUrl(base)!)!;
    expect(JSON.parse(row.extractionResults!)['$script']).toBe('T!');
  } finally {
    p.close();
  }
}, 60_000);
