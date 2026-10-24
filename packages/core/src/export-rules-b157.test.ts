import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exportPdfs } from './media-export.js';
import { exportSitemap } from './sitemap-export.js';
import { acceptedLastModified, parseSitemapLastmod } from './sitemap-lastmod.js';

// B157: four export rules the code enforces and no other test pinned. Each
// test fails when its rule is removed.
let dir: string;
let n = 0;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b157-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture(setup: (raw: DatabaseSync) => void, readOnly = false): ProjectDb {
  const file = path.join(dir, `p${n++}.seoproject`);
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  setup(raw);
  raw.close();
  return new ProjectDb(file, readOnly ? { readOnly: true } : undefined);
}

const lastmodOf = async (sitemapLastmod: string): Promise<string | null> => {
  const db = fixture((raw) => {
    raw.exec(
      `INSERT INTO urls (id, url, status_code, indexability, depth, crawled_at)
       VALUES (1, 'https://ex.com/', 200, 'indexable', 0, '2026-10-20 10:00:00')`,
    );
    raw
      .prepare('INSERT INTO sitemap_urls (url, lastmod, source_sitemap) VALUES (?, ?, ?)')
      .run('https://ex.com/', sitemapLastmod, 'https://ex.com/sitemap.xml');
  });
  const out = path.join(dir, `sitemap${n++}.xml`);
  await exportSitemap(db, out, { lastmod: 'sitemap' });
  db.close();
  return /<lastmod>([^<]*)<\/lastmod>/.exec(fs.readFileSync(out, 'utf8'))?.[1] ?? null;
};

describe('B157 lastmod a sitemap declares', () => {
  it('a date in the future never reaches the generated sitemap', async () => {
    expect(await lastmodOf('2099-01-01')).toBeNull();
    expect(await lastmodOf('2026-01-01')).toBe('2026-01-01');
  });

  it('a time out of range in lastmod gives no value, in the parser and in the generated sitemap', async () => {
    for (const text of ['2026-03-04T10:60:00Z', '2026-03-04T10:00:60Z', '2026-03-04T24:00:00Z']) {
      expect(parseSitemapLastmod(text)).toBeNull();
    }
    expect(parseSitemapLastmod('2026-03-04T23:59:59Z')).not.toBeNull();
    expect(await lastmodOf('2026-03-04T10:61:00Z')).toBeNull();
    expect(await lastmodOf('2026-03-04T10:20:00Z')).toBe('2026-03-04');
  });
});

describe('B157 crawl date is UTC', () => {
  const savedTz = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = 'America/New_York';
  });
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });
  const lm = (iso: string) => ({ 'last-modified': new Date(iso).toUTCString() });
  const NOW = Date.UTC(2026, 9, 22, 12);

  // `crawled_at` is SQLite's UTC text: read as local time the guard would sit hours off.
  it('the 60 s guard is measured from crawled_at as UTC, west of Greenwich', () => {
    // Read as local New York time the crawl would be 15:00 UTC and this value would pass.
    expect(acceptedLastModified(lm('2026-10-22T10:59:30Z'), '2026-10-22 11:00:00', NOW)).toBeNull();
  });
  it('the 60 s guard is measured from crawled_at as UTC, east of Greenwich', () => {
    process.env.TZ = 'Asia/Tokyo';
    // Read as local Tokyo time the crawl would be 02:00 UTC and this value would be rejected.
    expect(acceptedLastModified(lm('2026-10-22T05:00:00Z'), '2026-10-22 11:00:00', NOW)).not.toBeNull();
  });
});

describe('B157 PDF re-download', () => {
  let server: http.Server;
  let base: string;
  let seen: string[] = [];
  const BODY = Buffer.concat([Buffer.from('%PDF-1.4\nnew\n'), Buffer.alloc(2000, 7)]);

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': BODY.length });
      res.end(req.method === 'HEAD' ? undefined : BODY);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => void server.close());

  const project = (): ProjectDb =>
    fixture(
      (raw) =>
        raw.exec(
          // Crawled chunked: the size is unknown.
          `INSERT INTO urls (id, url, status_code, content_kind, content_length)
           VALUES (1, '${base}/a.pdf', 200, 'pdf', NULL)`,
        ),
      true,
    );

  it('a file of unknown size is fetched again when HEAD reports another size', async () => {
    const out = path.join(dir, 'out-head-differs');
    fs.mkdirSync(path.join(out, 'pdfs'), { recursive: true });
    const dest = path.join(out, 'pdfs', 'a.pdf');
    fs.writeFileSync(dest, Buffer.concat([Buffer.from('%PDF-1.4\nold\n'), Buffer.alloc(500, 1)]));
    seen = [];
    await exportPdfs(project(), out, { requestGapMs: 0 });
    expect(seen).toEqual(['HEAD /a.pdf', 'GET /a.pdf']);
    expect(fs.readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('a file of unknown size is kept when HEAD reports the same size', async () => {
    const out = path.join(dir, 'out-head-same');
    fs.mkdirSync(path.join(out, 'pdfs'), { recursive: true });
    const dest = path.join(out, 'pdfs', 'a.pdf');
    fs.writeFileSync(dest, BODY);
    seen = [];
    const r = await exportPdfs(project(), out, { requestGapMs: 0 });
    expect(seen).toEqual(['HEAD /a.pdf']);
    expect(r.errors).toEqual([]);
  });
});
