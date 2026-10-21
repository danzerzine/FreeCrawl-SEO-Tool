import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';

// Drives the built CLI as a process (`npm run build:cli` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

let dir: string;
let server: http.Server;
let base: string;
let hits = 0;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b129-'));
  hits = 0;
  server = http.createServer((_req, res) => {
    hits++;
    res.setHeader('content-type', 'text/html');
    res.end('<html><head><title>t</title></head><body>ok</body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

it.each([
  ['--include', 'include'],
  ['--exclude', 'exclude'],
])('%s with an invalid pattern exits 2 before crawling, --json says ok:false (B129)', async (flag, kind) => {
  const db = path.join(dir, 'p.seoproject');
  const r = await run([base, `${flag}=([`, '--db', db, '--json']);
  expect(r.code).toBe(2);
  const out = JSON.parse(r.stdout);
  expect(out.ok).toBe(false);
  expect(out.error).toContain(`Invalid ${kind} pattern "(["`);
  expect(r.stdout + r.stderr).not.toMatch(/\n\s+at /);
  expect(fs.existsSync(db)).toBe(false);
  expect(hits).toBe(0);
}, 30_000);
