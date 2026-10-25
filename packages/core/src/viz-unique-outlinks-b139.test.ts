import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { runSeoAuditExport } from './seo-audit-export.js';

/* B139: / links /b three times, /c and /d once and one external page; /c links itself and /b (nofollow). */
let server: Server;
let dir: string;
let base: string;
const PAGES: Record<string, string> = {
  '/': '<a href="/b">1</a><a href="/b">2</a><a href="/b">3</a><a href="/c">c</a><a href="/d">d</a><a href="https://elsewhere.example/x">x</a>',
  '/b': '<p>b</p>',
  '/c': '<a href="/c">self</a><a href="/b" rel="nofollow">nf</a>',
  '/d': '<a href="/b">b</a>',
};

beforeAll(async () => {
  dir = fs.mkdtempSync(join(tmpdir(), 'b139-'));
  server = createServer((req, res) => {
    const body = PAGES[req.url ?? ''];
    if (body === undefined) return void res.writeHead(404).end();
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(`<html><head><title>Page title long enough ${req.url}</title></head><body><h1>h</h1>${body}</body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Minimal CSV reader: the cells in this fixture hold no commas or quotes that matter. */
function rows(text: string): Record<string, string>[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const split = (l: string) => l.split(',').map((c) => c.replace(/^"|"$/g, ''));
  const head = split(lines[0]!);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((c, i) => [head[i], c])));
}

it('the visualization card counts unique internal outlinks, the number of the audit export Unique Outlinks column (B139)', async () => {
  const db = new ProjectDb(join(dir, 'p.seoproject'));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: `${base}/`,
      maxConcurrency: 1,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
    },
    db,
  );
  c.on('error', () => {});
  await c.start();
  const out = join(dir, 'out');
  await runSeoAuditExport(db, out);
  const nodes = db.graphSnapshot().nodes;
  db.close();
  const all = rows(fs.readFileSync(join(out, 'internal_all.csv'), 'utf8'));
  for (const p of ['/', '/b', '/c', '/d']) {
    const node = nodes.find((n) => n.url === `${base}${p}`)!;
    const exported = all.find((r) => r['Address'] === `${base}${p}`)!['Unique Outlinks'];
    expect(String(node.uniqueOutlinks), p).toBe(exported);
  }
  // / links /b, /c, /d and one external page: the card counts the three internal ones.
  const home = nodes.find((n) => n.url === `${base}/`)!;
  expect(home.uniqueOutlinks).toBe(3);
  expect(home.outlinks).toBeGreaterThan(home.uniqueOutlinks);
}, 30_000);
