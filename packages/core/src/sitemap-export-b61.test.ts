import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportSitemap, type SitemapOptions } from './sitemap-export.js';

let dir: string;
let file: string;

const u = (p: string) => `https://ex.com${p}`;

interface Fixture {
  id: number;
  path: string;
  depth?: number;
  crawledAt?: string;
  headers?: Record<string, string>;
  sitemapLastmod?: string | null;
  /** Row is in `sitemap_urls`. */
  inSitemap?: boolean;
}

function build(rows: Fixture[]): ProjectDb {
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, status_code, indexability, depth, crawled_at) VALUES (?, ?, 200, 'indexable', ?, ?)`,
  );
  const hdr = raw.prepare('INSERT INTO headers (url_id, name, value) VALUES (?, ?, ?)');
  const sm = raw.prepare('INSERT INTO sitemap_urls (url, lastmod, source_sitemap) VALUES (?, ?, ?)');
  for (const r of rows) {
    ins.run(r.id, u(r.path), r.depth ?? 0, r.crawledAt ?? '2026-10-20 10:00:00');
    for (const [k, v] of Object.entries(r.headers ?? {})) hdr.run(r.id, k, v);
    if (r.inSitemap ?? r.sitemapLastmod !== undefined) {
      sm.run(u(r.path), r.sitemapLastmod ?? null, u('/sitemap.xml'));
    }
  }
  raw.close();
  return new ProjectDb(file);
}

const lastmods = (xml: string): (string | null)[] =>
  xml.split('<url>').slice(1).map((b) => /<lastmod>([^<]*)<\/lastmod>/.exec(b)?.[1] ?? null);

const read = (p: string) => fs.readFileSync(p, 'utf8');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b61-'));
  file = path.join(dir, 'p.seoproject');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const FIVE: Fixture[] = [
  { id: 1, path: '/', depth: 0, crawledAt: '2026-10-20 10:00:00' },
  { id: 2, path: '/a', depth: 1, crawledAt: '2026-10-19 10:00:00' },
  { id: 3, path: '/b', depth: 1, crawledAt: '2026-10-18 10:00:00' },
  { id: 4, path: '/c', depth: 2, crawledAt: '2026-10-17 10:00:00' },
  { id: 5, path: '/d', depth: 2, crawledAt: '2026-10-16 10:00:00' },
];

// Output of the pre-B61 generator for FIVE (recorded before the change).
const GOLDEN_PART = (paths: string[], days: string[], prios: string[]) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  paths
    .map(
      (p, i) =>
        `  <url>\n    <loc>https://ex.com${p}</loc>\n    <lastmod>${days[i]}</lastmod>\n` +
        `    <changefreq>weekly</changefreq>\n    <priority>${prios[i]}</priority>\n  </url>\n`,
    )
    .join('') +
  '</urlset>\n';

describe("B61 lastmod: 'crawl' keeps the pre-change output", () => {
  it('single file, byte for byte', async () => {
    const db = build(FIVE);
    const out = path.join(dir, 'sitemap.xml');
    const r = await exportSitemap(db, out, { lastmod: 'crawl' } as SitemapOptions);
    db.close();
    expect(r).toMatchObject({ files: [out], urlsWritten: 5, sharded: false });
    expect(read(out)).toBe(
      GOLDEN_PART(
        ['/', '/a', '/b', '/c', '/d'],
        ['2026-10-20', '2026-10-19', '2026-10-18', '2026-10-17', '2026-10-16'],
        ['1.0', '0.9', '0.9', '0.8', '0.8'],
      ),
    );
  });

  it('sharded: part files byte for byte, index keeps today with the date substituted', async () => {
    const db = build(FIVE);
    const out = path.join(dir, 'sitemap.xml');
    const r = await exportSitemap(db, out, { lastmod: 'crawl', splitAtUrlCount: 2 } as SitemapOptions);
    db.close();
    expect(r.sharded).toBe(true);
    expect(r.files).toEqual([out, ...[1, 2, 3].map((i) => path.join(dir, `sitemap-${i}.xml`))]);
    expect(read(r.files[1]!)).toBe(GOLDEN_PART(['/', '/a'], ['2026-10-20', '2026-10-19'], ['1.0', '0.9']));
    expect(read(r.files[2]!)).toBe(GOLDEN_PART(['/b', '/c'], ['2026-10-18', '2026-10-17'], ['0.9', '0.8']));
    expect(read(r.files[3]!)).toBe(GOLDEN_PART(['/d'], ['2026-10-16'], ['0.8']));
    const today = new Date().toISOString().slice(0, 10);
    expect(read(out).replaceAll(today, 'TODAY')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        [1, 2, 3]
          .map((i) => `  <sitemap>\n    <loc>https://ex.com/sitemap-${i}.xml</loc>\n    <lastmod>TODAY</lastmod>\n  </sitemap>\n`)
          .join('') +
        '</sitemapindex>\n',
    );
  });
});

const http = (iso: string) => new Date(iso).toUTCString();
const DATE = http('2026-10-20T10:00:00Z');

/** Five URLs, one per branch of the chain. */
const CHAIN: Fixture[] = [
  // Last-Modified hours/days older than the response: accepted.
  { id: 1, path: '/old', headers: { 'last-modified': http('2026-08-01T08:00:00Z'), date: DATE }, sitemapLastmod: '2026-01-01' },
  // Server stamps "now": falls through to the sitemap lastmod.
  { id: 2, path: '/now', headers: { 'last-modified': http('2026-10-20T09:59:30Z'), date: DATE }, sitemapLastmod: '2026-03-03' },
  // Same, equal to crawled_at with no Date header, and no sitemap lastmod: none.
  { id: 3, path: '/nodate', crawledAt: '2026-10-20 10:00:00', headers: { 'last-modified': http('2026-10-20T10:00:00Z') } },
  // Future Last-Modified: rejected, sitemap lastmod used.
  { id: 4, path: '/future', headers: { 'last-modified': http('2099-01-01T00:00:00Z'), date: DATE }, sitemapLastmod: '2026-02-02' },
  // No headers at all, an unparsable sitemap lastmod: none.
  { id: 5, path: '/bare', sitemapLastmod: 'last tuesday' },
];

describe('B61 lastmod source chain', () => {
  const run = async (options?: SitemapOptions) => {
    const db = build(CHAIN);
    const out = path.join(dir, 'sitemap.xml');
    await exportSitemap(db, out, options);
    db.close();
    return lastmods(read(out));
  };

  it("default ('chain'): Last-Modified if accepted, else the sitemap's, else no <lastmod>", async () => {
    expect(await run()).toEqual(['2026-08-01', '2026-03-03', null, '2026-02-02', null]);
  });
  it("'last-modified': only the accepted header", async () => {
    expect(await run({ lastmod: 'last-modified' })).toEqual(['2026-08-01', null, null, null, null]);
  });
  it("'sitemap': only sitemap_urls.lastmod (unparsable dropped)", async () => {
    expect(await run({ lastmod: 'sitemap' })).toEqual(['2026-01-01', '2026-03-03', null, '2026-02-02', null]);
  });
  it("'none': no <lastmod> at all", async () => {
    expect(await run({ lastmod: 'none' })).toEqual([null, null, null, null, null]);
  });
  it("'crawl': the crawl date", async () => {
    expect(await run({ lastmod: 'crawl' })).toEqual(Array(5).fill('2026-10-20'));
  });
});

describe('B61 sitemap index lastmod per part', () => {
  const rows: Fixture[] = [
    { id: 1, path: '/1', headers: { 'last-modified': http('2026-08-01T08:00:00Z'), date: DATE } },
    { id: 2, path: '/2', sitemapLastmod: '2026-09-09' },
    { id: 3, path: '/3' },
    { id: 4, path: '/4' },
    { id: 5, path: '/5', sitemapLastmod: '2026-07-07' },
  ];

  it('is the newest lastmod of the part, omitted when the part has none', async () => {
    const db = build(rows);
    const out = path.join(dir, 'sitemap.xml');
    const r = await exportSitemap(db, out, { splitAtUrlCount: 2 });
    db.close();
    expect(r.sharded).toBe(true);
    expect(lastmods(read(r.files[1]!))).toEqual(['2026-08-01', '2026-09-09']);
    expect(lastmods(read(r.files[2]!))).toEqual([null, null]);
    expect(read(out).split('<sitemap>').slice(1).map((b) => /<lastmod>([^<]*)</.exec(b)?.[1] ?? null)).toEqual([
      '2026-09-09',
      null,
      '2026-07-07',
    ]);
  });

  it("'none' leaves the index without any <lastmod> too", async () => {
    const db = build(rows);
    const out = path.join(dir, 'sitemap.xml');
    await exportSitemap(db, out, { splitAtUrlCount: 2, lastmod: 'none' });
    db.close();
    expect(read(out)).not.toContain('<lastmod>');
  });
});

describe('B61 single file or index: decided by a COUNT with the stream filter', () => {
  const withVideo = (id: number, p: string): Fixture & { videos: string } => ({
    id,
    path: p,
    videos: JSON.stringify([{ contentLoc: u('/v.mp4'), playerLoc: null, thumbnail: u('/t.jpg') }]),
  });

  function buildWithVideos(plain: number, video: number): ProjectDb {
    const rows: Fixture[] = [];
    for (let i = 1; i <= plain + video; i++) rows.push({ id: i, path: `/p${i}` });
    const db = build(rows);
    db.close();
    const raw = new DatabaseSync(file);
    for (let i = plain + 1; i <= plain + video; i++) {
      raw.prepare('UPDATE urls SET videos = ? WHERE id = ?').run(withVideo(i, '').videos, i);
    }
    // One page whose video list is empty: not a video page.
    raw.prepare("UPDATE urls SET videos = '[]' WHERE id = 1").run();
    raw.close();
    return new ProjectDb(file);
  }

  it('countIndexableUrls equals the stream for the plain and the video variant', () => {
    const db = buildWithVideos(4, 3);
    expect(db.countIndexableUrls()).toBe([...db.iterateIndexableUrls()].length);
    expect(db.countIndexableUrls({ videoOnly: true })).toBe(
      [...db.iterateIndexableUrls()].filter((r) => r.videos && r.videos !== '[]').length,
    );
    expect(db.countIndexableUrls({ videoOnly: true })).toBe(3);
    // The sitemap stream is the same set, in the same order.
    expect([...db.iterateSitemapUrlRows()].map((r) => r.id)).toEqual([...db.iterateIndexableUrls()].map((r) => r.id));
    expect([...db.iterateSitemapUrlRows({ videoOnly: true })]).toHaveLength(3);
    db.close();
  });

  it('exactly splitAt pages is one file, no index', async () => {
    const db = build(FIVE.slice(0, 2));
    const r = await exportSitemap(db, path.join(dir, 's.xml'), { splitAtUrlCount: 2 });
    db.close();
    expect(r).toMatchObject({ sharded: false, urlsWritten: 2 });
    expect(r.files).toHaveLength(1);
  });

  it('video variant: pages without a video do not count towards the split', async () => {
    const db = buildWithVideos(4, 3);
    const r = await exportSitemap(db, path.join(dir, 'v.xml'), { variant: 'video', splitAtUrlCount: 3 });
    db.close();
    // 7 indexable pages, 3 with a video: fits one file of 3.
    expect(r).toMatchObject({ sharded: false, urlsWritten: 3 });
    expect((read(r.files[0]!).match(/<video:video>/g) ?? []).length).toBe(3);
  });

  it('video variant: more video pages than splitAt shards them', async () => {
    const db = buildWithVideos(2, 5);
    const r = await exportSitemap(db, path.join(dir, 'v.xml'), { variant: 'video', splitAtUrlCount: 2 });
    db.close();
    expect(r).toMatchObject({ sharded: true, urlsWritten: 5 });
    expect(r.files).toHaveLength(1 + 3);
  });
});
