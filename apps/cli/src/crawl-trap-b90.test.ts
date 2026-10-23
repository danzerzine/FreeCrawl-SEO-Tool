import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Drives the built CLI as a process (`npx tsc -b` first).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

let dir: string;
let site: http.Server;
let base: string;

// A faceted listing: every page links eight more combinations, 6 000 in all,
// each with its own text. No sitemap, so the crawl-trap rule R2 fires at its
// floor of 2 000 URLs (the missing sitemap has settled at once).
const POOL = 6000;
const facet = (i: number): string => {
  const page = (i % 50) + 1;
  const rest = Math.floor(i / 50);
  return `/shop/list?color=c${Math.floor(rest / 12)}&size=s${rest % 12}&sort=${['asc', 'desc'][page % 2]}&page=${page}`;
};
const indexOf = (u: URL): number =>
  (Number(u.searchParams.get('color')!.slice(1)) * 12 + Number(u.searchParams.get('size')!.slice(1))) * 50 +
  Number(u.searchParams.get('page')) -
  1;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b90-'));
  site = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const html = (b: string): void =>
      void res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(`<html><head><title>${u.pathname} ${u.search} title long enough</title></head><body>${b}</body></html>`);
    if (u.pathname === '/robots.txt' || u.pathname.startsWith('/sitemap')) return void res.writeHead(404).end();
    if (u.pathname === '/shop/list') {
      const i = indexOf(u);
      const next = [1, 7, 53, 211, 997, 1499, 2503, 3001].map((d) => (i + d) % POOL);
      const text = Array.from({ length: 30 }, (_, k) => `w${(i * 31 + k * 17) % 9973}`).join(' ');
      return html(`<p>${text}</p>` + next.map((n) => `<a href="${facet(n)}">f</a>`).join(' '));
    }
    html(`<a href="${facet(0)}">shop</a>`);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});

afterEach(async () => {
  await new Promise((r) => site.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [CLI, base, '--rps', '0', '--concurrency', '8', ...args]);
  let out = '';
  let err = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (err += d));
  return new Promise((r) => child.on('exit', (code) => r({ code, out, err })));
}

describe('crawl-trap warning on the command line (B90)', () => {
  it('prints the warn on stderr and a Warning line, exits 0', async () => {
    const r = await run(['--max', '3000', '--db', path.join(dir, 'a.seoproject')]);
    expect(r.err).toMatch(/\[warn\] Possible crawl trap: [\d,]+ URLs share the pattern .*color&page&size&sort/);
    expect(r.out).toMatch(/Warning: possible crawl trap: [\d,]+ URLs share the pattern .*color,page,size,sort/);
    expect(r.code).toBe(0);
  }, 120_000);

  it('--json carries site.crawlTraps with the finding and the warn as a JSON line', async () => {
    const r = await run(['--max', '3000', '--json', '--db', path.join(dir, 'b.seoproject')]);
    const doc = JSON.parse(r.out) as { site: { crawlTraps: Array<{ rule: string; key: string; count: number; samples: string[] }> } };
    expect(doc.site.crawlTraps).toHaveLength(1);
    expect(doc.site.crawlTraps[0]).toMatchObject({ rule: 'R2' });
    expect(doc.site.crawlTraps[0]!.count).toBeGreaterThanOrEqual(2000);
    const warn = r.err.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as { type: string; message: string });
    expect(warn.filter((w) => w.type === 'warn' && /Possible crawl trap/.test(w.message))).toHaveLength(1);
    expect(r.code).toBe(0);
  }, 120_000);

  it('a site without a trap has crawlTraps [] and no warning', async () => {
    const r = await run(['--max', '30', '--json', '--db', path.join(dir, 'c.seoproject')]);
    const doc = JSON.parse(r.out) as { site: { crawlTraps: unknown[] } };
    expect(doc.site.crawlTraps).toEqual([]);
    expect(r.err).not.toContain('Possible crawl trap');
  }, 60_000);
});
