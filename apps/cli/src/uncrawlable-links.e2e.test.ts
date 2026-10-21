import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';

const CLI = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const run = promisify(execFile);

const PAGES: Record<string, string> = {
  '/a': `<nav><span href="/x">X</span></nav>
         <main><a href="javascript:go('/y')">Y</a>
         <div onclick="location='/z'">Z</div>
         <a href="/b">B</a></main>`,
  '/b': '<main><p>b</p><a href="/a">A</a></main>',
};

let server: http.Server;
let base = '';
let dir = '';
const requested: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0]!;
    requested.push(p);
    const body = PAGES[p];
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('nf');
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(`<!doctype html><html><head><title>${p}</title></head><body>${body}</body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b4b-'));
  await run(process.execPath, [CLI, `${base}/a`, '--db', path.join(dir, 'p.seoproject'), '--max', '20', '--no-robots', '--json']);
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('CLI crawl: uncrawlable links', () => {
  it('stores each uncrawlable link of A, never requests it, crawls the normal link', () => {
    expect(requested).toContain('/b');
    for (const p of ['/x', '/y', '/z']) expect(requested).not.toContain(p);

    const db = new ProjectDb(path.join(dir, 'p.seoproject'));
    try {
      const aId = db.getUrlIdByUrl(`${base}/a`)!;
      const out = db.getOutlinks(aId, 100);
      expect(out.rows.filter((r) => !r.crawlable).map((r) => [r.uncrawlableTag, r.uncrawlableValue, r.toUrl])).toEqual([
        ['a', "javascript:go('/y')", `${base}/y`],
        ['span', '/x', `${base}/x`],
        ['div', "location='/z'", `${base}/z`],
      ]);
      expect(out.rows.filter((r) => r.crawlable).map((r) => r.toUrl)).toEqual([`${base}/b`]);

      expect(db.getOverviewCounts().issues.jsOnlyNavigation).toBe(1);
      const flagged = db.queryUrls({ limit: 10, offset: 0, category: 'issues:js-only-navigation' });
      expect(flagged.rows.map((r) => r.url)).toEqual([`${base}/a`]);

      for (const p of ['/x', '/y', '/z']) {
        expect(db.getInlinks(`${base}${p}`, 10).total).toBe(0);
        expect(db.getUrlIdByUrl(`${base}${p}`)).toBeNull();
      }
      expect(db.getInlinks(`${base}/b`, 10).total).toBe(1);
    } finally {
      db.close();
    }
  });
});
