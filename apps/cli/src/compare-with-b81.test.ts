import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Drives the built CLI as a process (`npx tsc -b` first). Async spawn: the
// local server runs in this process.
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, ...args]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  return new Promise((r) => child.on('exit', (status) => r({ status, stdout, stderr })));
}

let dir: string;
let server: http.Server;
let base: string;
let renamed = false;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b81-cli-'));
  server = http.createServer((req, res) => {
    const title = req.url === '/p/1' && renamed ? 'Renamed' : `Page ${req.url}`;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>${title}</title></head><body><a href="/p/1">p1</a></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const first = await run([base, '--no-robots', '--db', path.join(dir, 'site.seoproject'), '--json']);
  if (first.status !== 0) throw new Error(`fixture crawl exited ${first.status}: ${first.stderr}`);
  fs.copyFileSync(path.join(dir, 'site.seoproject'), path.join(dir, 'previous.seoproject'));
  renamed = true;
}, 90000);

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('freecrawl <url> --compare-with (B81)', () => {
  it('--json carries the change counts against the other project', async () => {
    const previous = path.join(dir, 'previous.seoproject');
    const r = await run([base, '--no-robots', '--db', path.join(dir, 'site.seoproject'), '--compare-with', previous, '--json']);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { compare: { with: string; counts: Record<string, number> } };
    expect(out.compare.with).toBe(previous);
    expect(out.compare.counts.title).toBe(1);
  }, 60000);

  it('with --export-dir the compare files go there next to the exports', async () => {
    const outDir = path.join(dir, 'out');
    const r = await run([
      base, '--no-robots', '--db', path.join(dir, 'site2.seoproject'),
      '--compare-with', path.join(dir, 'previous.seoproject'),
      '--export-dir', outDir, '--export', 'issues',
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Changes since the previous crawl .*title 1/);
    expect(fs.readFileSync(path.join(outDir, 'compare-title.csv'), 'utf8')).toContain('Renamed');
    expect(fs.existsSync(path.join(outDir, 'compare-summary.json'))).toBe(true);
  }, 60000);

  it('a missing file or the crawl\'s own project exits 2 before crawling', async () => {
    const db = path.join(dir, 'site3.seoproject');
    const missing = await run([base, '--db', db, '--compare-with', path.join(dir, 'nope.seoproject')]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('nope.seoproject');
    const own = await run([base, '--db', db, '--compare-with', db]);
    expect(own.status).toBe(2);
    expect(own.stderr).toContain('--compare-with');
    expect(fs.existsSync(db)).toBe(false);
  });
});
