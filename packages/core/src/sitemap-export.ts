import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createGzip } from 'node:zlib';
import path from 'node:path';
import type { ProjectDb } from '@freecrawl/db';
import { writeExportFile } from './export-file.js';
import { acceptedLastModified, parseSitemapLastmod } from './sitemap-lastmod.js';

export type SitemapVariant =
  | 'standard'
  | 'image'
  | 'hreflang'
  | 'news'
  | 'video';

/**
 * Where each `<lastmod>` comes from.
 *  - `chain` (default) — the page's own `Last-Modified` when it can be trusted
 *    (see `acceptedLastModified`), else the lastmod the site's own sitemap
 *    declared, else no `<lastmod>`: a missing date beats a false one.
 *  - `last-modified` / `sitemap` — only that source.
 *  - `crawl` — the crawl date (the pre-B61 behaviour).
 *  - `none` — no `<lastmod>`.
 */
export type SitemapLastmodSource = 'chain' | 'last-modified' | 'sitemap' | 'crawl' | 'none';

export interface SitemapOptions {
  /** Default `'chain'`. */
  lastmod?: SitemapLastmodSource;
  /** Default `'weekly'`. Sitemaps.org change-frequency hint. */
  changefreq?:
    | 'always'
    | 'hourly'
    | 'daily'
    | 'weekly'
    | 'monthly'
    | 'yearly'
    | 'never';
  /**
   * Depth-based priority (1.0 for depth 0, declines 0.1 per level, floor 0.1)
   * if `true` (default). If `false`, emits 0.5 uniformly.
   */
  depthPriority?: boolean;
  /**
   * Sitemap content variant.
   *  - `standard`  — plain `<url><loc>...</loc></url>` (sitemaps.org core).
   *  - `image`     — adds `<image:image><image:loc>...</image:loc></image:image>` per page (Google Images).
   *  - `hreflang`  — adds `<xhtml:link rel="alternate" hreflang="..." href="..." />` siblings (Google international).
   *  - `news`      — adds a `<news:news>` block (publication name/language, publication
   *                  date, title) per page (Google News). Publication name comes from
   *                  `og:site_name` (host fallback), language from the page `lang`
   *                  attribute, and the date from the crawl time — Google News also
   *                  expects only recent articles, so treat the output as a template.
   */
  variant?: SitemapVariant;
  /** Gzip the output (`.xml.gz`). When true the file path is auto-suffixed. */
  gzip?: boolean;
  /**
   * Per-file URL cap. The sitemap protocol mandates ≤50,000 URLs and
   * ≤50 MB per file. Setting this lower than 50,000 is occasionally
   * useful when individual entries are large (image variant).
   */
  splitAtUrlCount?: number;
  /**
   * Absolute base URL (origin) the sharded sitemap-index `<loc>` entries are
   * built from, e.g. `https://example.com`. The protocol requires index
   * `<loc>` values to be fully-qualified URLs; without this they fell back
   * to bare filenames and Search Console rejected the index. When omitted,
   * the origin is derived from the first crawled URL.
   */
  baseUrl?: string;
}

export interface SitemapExportResult {
  /** All sitemap files written, absolute paths. First entry is the index when split. */
  files: string[];
  /** Total URLs written across all parts. */
  urlsWritten: number;
  /** True when an explicit URL cap (default 50K) was hit and writing stopped. */
  truncated: boolean;
  /** True when the result was sharded into multiple parts under an index. */
  sharded: boolean;
}

const HARD_URL_LIMIT = 50_000;

function escapeXml(s: string): string {
  return (
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // XML 1.0 forbids these regardless of escaping. They reach the news
      // variant through page titles and the image variant through `alt`
      // (which, unlike title, isn't trimmed), and one occurrence makes the
      // whole sitemap unreadable — Search Console reports "Sitemap could
      // not be read" with no indication of which URL caused it.
      // eslint-disable-next-line no-control-regex -- intentionally matching control chars to strip them
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  );
}

function formatLastmod(crawledAt: string): string {
  const date = crawledAt.slice(0, 10);
  return date.length === 10 ? date : new Date().toISOString().slice(0, 10);
}

function priorityForDepth(depth: number, depthBased: boolean): string {
  if (!depthBased) return '0.5';
  const p = Math.max(0.1, 1 - depth * 0.1);
  return p.toFixed(1);
}

/** Best-effort publication name for the news variant when `og:site_name`
 *  is absent — fall back to the URL's hostname (e.g. `www.example.com`). */
function hostnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname || rawUrl;
  } catch {
    return rawUrl;
  }
}

/** ISO 639-1 language code for `<news:language>`: take the primary subtag
 *  of the page `lang` (e.g. `en-US` → `en`), lowercased; default `en`. */
function newsLanguage(lang: string | null): string {
  const primary = (lang ?? '').trim().split(/[-_]/)[0]?.toLowerCase();
  return primary && /^[a-z]{2,3}$/.test(primary) ? primary : 'en';
}

/** Full W3C datetime for `<news:publication_date>` — the crawl timestamp is
 *  the only per-URL date we have; Google accepts complete ISO 8601. */
function newsPublicationDate(crawledAt: string): string {
  return crawledAt && crawledAt.length >= 10
    ? crawledAt
    : new Date().toISOString();
}

/**
 * Produce the right `<urlset>` opening tag for the chosen variant.
 * The XML namespace declarations are extension-aware so consumers
 * (Google Search Console, sitemaps.org validators) parse the file.
 */
function urlsetOpen(variant: SitemapVariant): string {
  const ns = ['xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'];
  if (variant === 'image') ns.push('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
  if (variant === 'hreflang') ns.push('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
  if (variant === 'news') ns.push('xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"');
  if (variant === 'video') ns.push('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
  return `<urlset ${ns.join(' ')}>\n`;
}

interface VideoRow {
  contentLoc: string | null;
  playerLoc: string | null;
  thumbnail: string | null;
}

interface UrlEntry {
  id: number;
  url: string;
  depth: number;
  crawledAt: string;
  hreflangs: string | null;
  title: string | null;
  lang: string | null;
  ogSiteName: string | null;
  videos: string | null;
  metaDescription: string | null;
  ogImage: string | null;
  /** `YYYY-MM-DD` for the `<lastmod>`, null for none. */
  lastmod: string | null;
}

/** Facts about one written part, read after it is written. */
interface PartStats {
  count: number;
  /** Newest `<lastmod>` of the part's URLs, null when none has one. */
  newest: string | null;
}

/** Google caps `<video:title>` at 100 chars and `<video:description>` at
 *  2048 — clamp so the sitemap validates. */
function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

async function writePart(
  filePath: string,
  entries: Iterable<UrlEntry>,
  stats: PartStats,
  variant: SitemapVariant,
  changefreq: string,
  depthBased: boolean,
  gzip: boolean,
  imagesFor: (urlId: number) => { src: string; alt: string | null }[],
): Promise<void> {
  const gen = async function* (): AsyncGenerator<string> {
    yield '<?xml version="1.0" encoding="UTF-8"?>\n';
    yield urlsetOpen(variant);
    for (const e of entries) {
      stats.count++;
      if (e.lastmod && (!stats.newest || e.lastmod > stats.newest)) stats.newest = e.lastmod;
      yield '  <url>\n';
      yield `    <loc>${escapeXml(e.url)}</loc>\n`;
      // News entries carry their own <news:publication_date>; the core
      // <lastmod>/<changefreq>/<priority> hints aren't part of the news
      // schema, so we omit them for a clean, valid news sitemap.
      if (variant !== 'news') {
        if (e.lastmod) yield `    <lastmod>${e.lastmod}</lastmod>\n`;
        yield `    <changefreq>${changefreq}</changefreq>\n`;
        yield `    <priority>${priorityForDepth(e.depth, depthBased)}</priority>\n`;
      }

      if (variant === 'news') {
        const pubName = e.ogSiteName?.trim() || hostnameOf(e.url);
        yield '    <news:news>\n';
        yield '      <news:publication>\n';
        yield `        <news:name>${escapeXml(pubName)}</news:name>\n`;
        yield `        <news:language>${escapeXml(newsLanguage(e.lang))}</news:language>\n`;
        yield '      </news:publication>\n';
        yield `      <news:publication_date>${escapeXml(newsPublicationDate(e.crawledAt))}</news:publication_date>\n`;
        yield `      <news:title>${escapeXml(e.title?.trim() || e.url)}</news:title>\n`;
        yield '    </news:news>\n';
      }

      if (variant === 'video' && e.videos) {
        let vids: VideoRow[] = [];
        try {
          const parsed = JSON.parse(e.videos) as unknown;
          if (Array.isArray(parsed)) vids = parsed as VideoRow[];
        } catch {
          // Malformed JSON — skip this page's videos.
        }
        const title = clamp((e.title?.trim() || e.url), 100);
        const description = clamp(
          (e.metaDescription?.trim() || e.title?.trim() || e.url),
          2048,
        );
        for (const v of vids) {
          // Google requires a thumbnail; fall back to the page's og:image
          // when the video itself doesn't declare one, and skip the entry
          // if neither is available (an entry without one is invalid).
          const thumb = v.thumbnail?.trim() || e.ogImage?.trim() || '';
          const media = v.contentLoc?.trim() || v.playerLoc?.trim() || '';
          if (!thumb || !media) continue;
          yield '    <video:video>\n';
          yield `      <video:thumbnail_loc>${escapeXml(thumb)}</video:thumbnail_loc>\n`;
          yield `      <video:title>${escapeXml(title)}</video:title>\n`;
          yield `      <video:description>${escapeXml(description)}</video:description>\n`;
          if (v.contentLoc?.trim()) {
            yield `      <video:content_loc>${escapeXml(v.contentLoc.trim())}</video:content_loc>\n`;
          } else if (v.playerLoc?.trim()) {
            yield `      <video:player_loc>${escapeXml(v.playerLoc.trim())}</video:player_loc>\n`;
          }
          yield '    </video:video>\n';
        }
      }

      if (variant === 'image') {
        const imgs = imagesFor(e.id);
        for (const img of imgs) {
          yield '    <image:image>\n';
          yield `      <image:loc>${escapeXml(img.src)}</image:loc>\n`;
          if (img.alt) yield `      <image:caption>${escapeXml(img.alt)}</image:caption>\n`;
          yield '    </image:image>\n';
        }
      }

      if (variant === 'hreflang' && e.hreflangs) {
        try {
          const list = JSON.parse(e.hreflangs) as { lang?: string; href?: string }[];
          if (Array.isArray(list)) {
            for (const h of list) {
              if (typeof h.lang === 'string' && typeof h.href === 'string') {
                yield `    <xhtml:link rel="alternate" hreflang="${escapeXml(h.lang)}" href="${escapeXml(h.href)}" />\n`;
              }
            }
          }
        } catch {
          // Malformed JSON — skip hreflang block for this URL.
        }
      }

      yield '  </url>\n';
    }
    yield '</urlset>\n';
  };

  const source = Readable.from(gen());
  await writeExportFile(filePath, async (partPath) => {
    const sink = createWriteStream(partPath, { encoding: gzip ? undefined : 'utf8' });
    if (gzip) {
      await pipeline(source.pipe(stringEncodeStream()), createGzip(), sink);
    } else {
      await pipeline(source, sink);
    }
  });
}

/**
 * Tiny passthrough that converts the async-iterable's string chunks
 * into Buffer for the gzip stream. (Readable.from with an async
 * generator emits string objects in object-mode; gzip expects bytes.)
 */
function stringEncodeStream(): Transform {
  return new Transform({
    writableObjectMode: true,
    readableObjectMode: false,
    transform(chunk, _enc, cb) {
      cb(null, Buffer.from(chunk as string, 'utf8'));
    },
  });
}

async function writeIndex(
  filePath: string,
  parts: { loc: string; lastmod: string | null }[],
  gzip: boolean,
): Promise<void> {
  const gen = async function* (): AsyncGenerator<string> {
    yield '<?xml version="1.0" encoding="UTF-8"?>\n';
    yield '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    for (const part of parts) {
      yield '  <sitemap>\n';
      yield `    <loc>${escapeXml(part.loc)}</loc>\n`;
      if (part.lastmod) yield `    <lastmod>${part.lastmod}</lastmod>\n`;
      yield '  </sitemap>\n';
    }
    yield '</sitemapindex>\n';
  };
  const source = Readable.from(gen());
  await writeExportFile(filePath, async (partPath) => {
    const sink = createWriteStream(partPath, { encoding: gzip ? undefined : 'utf8' });
    if (gzip) {
      await pipeline(source.pipe(stringEncodeStream()), createGzip(), sink);
    } else {
      await pipeline(source, sink);
    }
  });
}

/**
 * Write a sitemap (or a multi-part sharded sitemap with index) from the
 * crawl DB's indexable internal HTML URLs. Returns the list of files
 * written so the UI can surface them all to the user.
 *
 * Streamed: the URLs are read in pages and written as they come, so memory
 * does not grow with the site. Whether the result is one file or an index
 * with parts is decided up front by a COUNT with the same filter as the
 * stream.
 *
 * Sharding: when the input set exceeds `splitAtUrlCount` (default 50K),
 * the export switches to:
 *   - `<filePath>` (or `<filePath>.gz`) — the **index** file
 *   - `<filePath>-1.xml`, `<filePath>-2.xml`, … (or `.xml.gz`) — parts
 * Index file always points to the parts via fully-qualified URLs that
 * preserve the input file's extension (so the user can drop the whole
 * directory into a webroot as-is). Each part's `<lastmod>` in the index is
 * the newest of its URLs (none when it has none; the crawl date in `crawl`
 * mode).
 */
export function exportSitemap(
  db: ProjectDb,
  filePath: string,
  options: SitemapOptions = {},
): Promise<SitemapExportResult> {
  // Read through SQLite's page cache, not the memory map: the map would
  // pull every page of a big project into the process as the export reads it.
  return db.withoutMmap(() => writeSitemap(db, filePath, options));
}

async function writeSitemap(
  db: ProjectDb,
  filePath: string,
  options: SitemapOptions,
): Promise<SitemapExportResult> {
  const changefreq = options.changefreq ?? 'weekly';
  const depthBased = options.depthPriority ?? true;
  const variant: SitemapVariant = options.variant ?? 'standard';
  const gzip = options.gzip ?? false;
  const lastmodSource = options.lastmod ?? 'chain';
  const splitAt = Math.min(HARD_URL_LIMIT, options.splitAtUrlCount ?? HARD_URL_LIMIT);
  const now = Date.now();
  const lookup = lastmodSource === 'crawl' || lastmodSource === 'none' ? null : db.lastmodSourceLookup();

  const lastmodFor = (row: { id: number; url: string; crawledAt: string }): string | null => {
    if (lastmodSource === 'none') return null;
    if (lastmodSource === 'crawl') return row.crawledAt ? formatLastmod(row.crawledAt) : null;
    const src = lookup!(row.id, row.url);
    const fromHeader =
      lastmodSource === 'sitemap' ? null : (acceptedLastModified(src.headers, row.crawledAt, now)?.day ?? null);
    if (fromHeader || lastmodSource === 'last-modified') return fromHeader;
    const declared = src.sitemapLastmod ? parseSitemapLastmod(src.sitemapLastmod) : null;
    return declared && declared.ms <= now ? declared.day : null;
  };

  // One pass over the URLs, one entry at a time. The video sitemap's filter
  // is in the query, the same one `countIndexableUrls` uses.
  const stream = (function* (): Generator<UrlEntry> {
    for (const row of db.iterateSitemapUrlRows({ videoOnly: variant === 'video' })) {
      yield { ...row, lastmod: lastmodFor(row) };
    }
  })();
  // One entry of lookahead, so a part knows whether more follow.
  let ahead = stream.next();
  const take = function* (limit: number): Generator<UrlEntry> {
    for (let n = 0; n < limit && !ahead.done; n++) {
      const entry = ahead.value;
      ahead = stream.next();
      yield entry;
    }
  };
  const firstUrl = ahead.done ? '' : ahead.value.url;

  const ext = gzip ? '.xml.gz' : path.extname(filePath) || '.xml';
  const base =
    path.extname(filePath) === '.gz'
      ? filePath.replace(/\.xml\.gz$/i, '').replace(/\.gz$/i, '')
      : filePath.replace(/\.xml$/i, '');

  const imagesFor = (urlId: number) =>
    variant === 'image' ? db.imagesForUrl(urlId, 1000) : [];

  // Single-file path: total fits in one shard, no index needed.
  const total = db.countIndexableUrls({ videoOnly: variant === 'video' });
  if (total <= splitAt) {
    const out = gzip && !filePath.endsWith('.gz') ? `${filePath}.gz` : filePath;
    const stats: PartStats = { count: 0, newest: null };
    await writePart(out, take(Infinity), stats, variant, changefreq, depthBased, gzip, imagesFor);
    return {
      files: [out],
      urlsWritten: stats.count,
      truncated: false,
      sharded: false,
    };
  }

  // Sharded — write parts then the index. Truncation only applies if the
  // user explicitly capped via `splitAtUrlCount`; we treat the protocol
  // 50K cap as the hard limit per part, not on the total set.
  const files: string[] = [];
  let written = 0;
  const partFiles: string[] = [];
  const partLastmods: (string | null)[] = [];
  let partIndex = 1;
  while (!ahead.done) {
    const partPath = `${base}-${partIndex}${ext}`;
    const stats: PartStats = { count: 0, newest: null };
    await writePart(partPath, take(splitAt), stats, variant, changefreq, depthBased, gzip, imagesFor);
    partFiles.push(partPath);
    partLastmods.push(stats.newest);
    files.push(partPath);
    written += stats.count;
    partIndex++;
  }

  const indexPath = gzip && !filePath.endsWith('.gz') ? `${filePath}.gz` : filePath;
  // The sitemap protocol requires index <loc> values to be fully-qualified
  // URLs — a bare filename makes Search Console reject the index. Resolve
  // the part filenames against the crawl origin (explicit baseUrl, else the
  // first crawled URL's origin). If no origin can be derived we fall back to
  // basenames rather than failing the export.
  let origin = '';
  const rawBase = (options.baseUrl ?? firstUrl).trim();
  if (rawBase) {
    try {
      origin = new URL(rawBase).origin;
    } catch {
      origin = '';
    }
  }
  const locFor = (p: string): string => {
    const name = path.basename(p);
    return origin ? `${origin}/${name}` : name;
  };
  const today = new Date(now).toISOString().slice(0, 10);
  await writeIndex(
    indexPath,
    partFiles.map((p, i) => ({
      loc: locFor(p),
      lastmod: lastmodSource === 'crawl' ? today : (partLastmods[i] ?? null),
    })),
    gzip,
  );
  files.unshift(indexPath);

  return {
    files,
    urlsWritten: written,
    truncated: false,
    sharded: true,
  };
}
