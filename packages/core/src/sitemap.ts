import * as cheerio from 'cheerio';
import { gunzipSync } from 'node:zlib';
import { fetch as undiciFetch } from 'undici';
import { normalizeUrl, type UrlRewriteOptions } from './url-utils.js';
import { defaultRequestHeaders, formatFetchError } from './http-client.js';
import type { SitemapFileRow } from '@freecrawl/shared-types';

/**
 * sitemaps.org protocol limits. A sitemap breaching either is still parsed
 * (the data is useful and Google reads what it can), but the breach is
 * reported as a warning so the user can fix the generator.
 */
const SITEMAP_MAX_URLS = 50_000;
const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;
/**
 * Hard ceiling on what a gzipped sitemap may inflate to.
 *
 * `SITEMAP_MAX_BYTES` above is the sitemaps.org limit, and breaching it is
 * deliberately only a warning — the data is still useful. But that check
 * ran *after* `gunzipSync` had already materialised the whole buffer, so
 * a decompression bomb (a few KB inflating to gigabytes) allocated all of
 * it first and could take the process down. Sitemaps are fetched with no
 * user action at all (`discoverSitemaps` defaults on), so the input is not
 * something the user chose to trust.
 *
 * 4× the protocol limit: no real sitemap comes close, and a bomb is orders
 * of magnitude past it.
 */
const SITEMAP_MAX_INFLATED_BYTES = SITEMAP_MAX_BYTES * 4;

/**
 * Content types a sitemap may legitimately arrive as. Servers are sloppy
 * here — `text/plain` and `application/octet-stream` are common for `.xml`
 * files on misconfigured hosts — so a mismatch is a warning, never a
 * rejection: the body is still parsed and only flagged.
 */
const SITEMAP_OK_CONTENT_TYPES = [
  'xml', // application/xml, text/xml, application/rss+xml, atom+xml
  'gzip',
  'x-gzip',
  'octet-stream',
  'text/plain',
];

/** Magic bytes every gzip member starts with (RFC 1952 §2.3.1). */
function looksGzipped(buf: Uint8Array): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

export interface SitemapEntry {
  /** Absolute URL of the actual page (the sitemap's `<loc>` value). */
  url: string;
  /** ISO 8601 date or `null`. Stored as text (servers vary, no point parsing). */
  lastmod: string | null;
  /** 0.0–1.0 priority, or `null`. */
  priority: number | null;
  /** `always` / `hourly` / `daily` / `weekly` / `monthly` / `yearly` / `never`, or `null`. */
  changefreq: string | null;
  /** The sitemap URL where this entry was found (for traceability). */
  source: string;
}

interface ParsedSitemap {
  type: 'urlset' | 'sitemapindex' | 'unknown';
  entries: SitemapEntry[];
  childSitemaps: string[];
}

export interface SitemapDiscoveryResult {
  /** Sitemap URLs we attempted to fetch (root + nested via index). */
  sitemapsTried: string[];
  /** Sitemap URLs that returned valid XML and were parsed. */
  sitemapsParsed: string[];
  /** Per-sitemap error message (only sitemapsTried entries that failed). */
  errors: { sitemap: string; error: string }[];
  /** All entries flattened across every parsed sitemap, capped at `maxUrls`. */
  entries: SitemapEntry[];
  /** True if `maxUrls` cap was hit and additional entries were dropped. */
  truncated: boolean;
  /**
   * Non-fatal protocol breaches found while reading (sitemaps.org 50,000-URL
   * / 50 MB caps, unexpected content types). The sitemap was still parsed —
   * these are reported so the user can fix the generator.
   */
  warnings: { sitemap: string; warning: string }[];
  /** Every sitemap file met while walking, in the order met, with its own numbers. */
  files: SitemapFileRow[];
}

/**
 * Pull `Sitemap:` directives out of a robots.txt body. Falls back to the
 * two conventional locations when robots.txt is silent — these cover the
 * vast majority of real-world sites.
 */
export function parseSitemapsFromRobots(robotsText: string): string[] {
  const out: string[] = [];
  for (const rawLine of robotsText.split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(rawLine);
    if (m && m[1]) out.push(m[1].trim());
  }
  return out;
}

/**
 * Find candidate sitemap URLs for a given origin. Order:
 *   1. Sitemap directives in `<origin>/robots.txt`
 *   2. Default fallbacks `<origin>/sitemap.xml` and `/sitemap_index.xml`
 *
 * Always returns at least the two fallbacks even if robots.txt yields
 * sitemaps — some sites declare a partial set.
 */
export async function discoverSitemapUrls(
  origin: string,
  userAgent: string,
  signal: AbortSignal,
  opts: {
    /** `Sitemap:` lines of a robots.txt the caller already read; skips the request. */
    robotsSitemaps?: readonly string[];
    beforeRequest?: () => Promise<void>;
  } = {},
): Promise<string[]> {
  const candidates = new Set<string>(opts.robotsSitemaps);
  if (opts.robotsSitemaps) {
    candidates.add(`${origin}/sitemap.xml`);
    candidates.add(`${origin}/sitemap_index.xml`);
    return [...candidates];
  }
  try {
    await opts.beforeRequest?.();
    const res = await undiciFetch(`${origin}/robots.txt`, {
      method: 'GET',
      headers: defaultRequestHeaders(userAgent, 'en'),
      redirect: 'follow',
      signal,
    });
    if (res.ok) {
      const text = await res.text();
      for (const u of parseSitemapsFromRobots(text)) candidates.add(u);
    } else {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
    }
  } catch {
    // robots.txt unreachable — fall through to defaults.
  }
  candidates.add(`${origin}/sitemap.xml`);
  candidates.add(`${origin}/sitemap_index.xml`);
  return [...candidates];
}

/**
 * Parse a single sitemap or sitemap-index XML body. Uses cheerio's XML
 * mode — robust to namespace prefixes (`<xhtml:link>`) and odd whitespace.
 */
function parseSitemap(xml: string, sourceUrl: string): ParsedSitemap {
  const $ = cheerio.load(xml, { xmlMode: true });

  // Index — pointers to other sitemaps.
  const indexLocs: string[] = [];
  $('sitemapindex sitemap > loc').each((_, el) => {
    const u = $(el).text().trim();
    if (u) indexLocs.push(u);
  });
  if (indexLocs.length > 0) {
    return { type: 'sitemapindex', entries: [], childSitemaps: indexLocs };
  }

  // urlset — actual page entries.
  const entries: SitemapEntry[] = [];
  $('urlset url').each((_, el) => {
    const $u = $(el);
    const loc = $u.find('loc').first().text().trim();
    if (!loc) return;
    const lastmod = $u.find('lastmod').first().text().trim() || null;
    const changefreq = $u.find('changefreq').first().text().trim().toLowerCase() || null;
    const priorityRaw = $u.find('priority').first().text().trim();
    let priority: number | null = null;
    if (priorityRaw) {
      const p = Number.parseFloat(priorityRaw);
      if (Number.isFinite(p)) priority = Math.max(0, Math.min(1, p));
    }
    entries.push({ url: loc, lastmod, priority, changefreq, source: sourceUrl });
  });
  if (entries.length > 0) {
    return { type: 'urlset', entries, childSitemaps: [] };
  }

  return { type: 'unknown', entries: [], childSitemaps: [] };
}

interface FetchOpts {
  userAgent: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxUrls: number;
  /** Max sitemap-index nesting (1 = root only, 2 = root + children, …). */
  maxDepth: number;
  /**
   * The crawl's URL-rewrite policy. Sitemap entries MUST be normalised with
   * the same rewrites the crawler applies to page URLs — otherwise the
   * stored `sitemap_urls.url` (e.g. `…/about/`) never equals the crawled
   * `urls.url` (`…/about` under Trailing Slash = Strip), and every
   * sitemap↔crawl join silently reports "crawled but not in sitemap" for
   * every page and "sitemap orphan" for every sitemap entry.
   */
  rewrites?: UrlRewriteOptions;
  /** Awaited before each request; the crawler passes its rate gate. */
  beforeRequest?: () => Promise<void>;
}

/**
 * BFS-walk the sitemap tree starting from `roots` (typically what
 * `discoverSitemapUrls` returns). Visited sitemap URLs are deduped so an
 * accidental cycle in `<sitemapindex>` can't loop forever. Caps total
 * entries at `maxUrls`; further finds are dropped and the `truncated` flag
 * flips on the result, but the files after the cap are still read for their
 * counts, so a breach in a later file is not missed. A file nested past
 * `maxDepth` is listed in `files` without being fetched.
 */
export async function fetchSitemaps(
  roots: string[],
  opts: FetchOpts,
): Promise<SitemapDiscoveryResult> {
  const result: SitemapDiscoveryResult = {
    sitemapsTried: [],
    sitemapsParsed: [],
    errors: [],
    entries: [],
    truncated: false,
    warnings: [],
    files: [],
  };
  const visited = new Set<string>();
  type QueueItem = { url: string; depth: number };
  const queue: QueueItem[] = roots.map((url) => ({ url, depth: 1 }));

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    if (visited.has(item.url)) continue;
    await opts.beforeRequest?.();
    visited.add(item.url);
    const file: SitemapFileRow = {
      url: item.url,
      status: null,
      bytes: null,
      inflatedBytes: null,
      urlCount: null,
      childCount: null,
      duplicateEntries: null,
      warnings: [],
      error: null,
      reason: null,
    };
    result.files.push(file);
    if (item.depth > opts.maxDepth) {
      file.reason = 'too-deep';
      continue;
    }
    const countOnly = result.entries.length >= opts.maxUrls;
    if (countOnly) {
      result.truncated = true;
      file.reason = 'counted-only';
    }
    result.sitemapsTried.push(item.url);
    const warn = (warning: string) => {
      result.warnings.push({ sitemap: item.url, warning });
      file.warnings.push(warning);
    };
    const fail = (error: string) => {
      result.errors.push({ sitemap: item.url, error });
      file.error = error;
    };

    try {
      const res = await undiciFetch(item.url, {
        method: 'GET',
        headers: defaultRequestHeaders(opts.userAgent, 'en'),
        redirect: 'follow',
        signal: opts.signal,
      });
      file.status = res.status;
      if (!res.ok) {
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        fail(`HTTP ${res.status}`);
        continue;
      }
      const ct = (res.headers.get('content-type') ?? '').toLowerCase();
      // Read as bytes, not text: a `.xml.gz` sitemap arrives as raw gzip
      // (Content-Type: application/gzip and NO Content-Encoding, so undici
      // does not decompress it for us). Decoding those bytes as UTF-8 would
      // yield mojibake that parses to zero URLs.
      const raw = new Uint8Array(await res.arrayBuffer());
      file.bytes = raw.byteLength;

      // Protocol size cap. Measured on the bytes actually served; the spec's
      // 50 MB is the *uncompressed* limit, so for gzip we re-check after
      // inflating below.
      if (raw.byteLength > SITEMAP_MAX_BYTES) {
        warn(
          `Sitemap is ${(raw.byteLength / (1024 * 1024)).toFixed(1)} MB, over the sitemaps.org 50 MB limit.`,
        );
      }

      // Gzip detection by magic bytes rather than by header or extension:
      // plenty of servers mislabel `.xml.gz` as `text/xml`, and some serve a
      // plain XML file from a `.gz` URL. The bytes are the ground truth.
      let xml: string;
      if (looksGzipped(raw)) {
        try {
          // `maxOutputLength` makes zlib abort mid-inflation instead of
          // allocating the whole bomb and checking its size afterwards.
          const inflated = gunzipSync(raw, {
            maxOutputLength: SITEMAP_MAX_INFLATED_BYTES,
          });
          file.inflatedBytes = inflated.byteLength;
          if (inflated.byteLength > SITEMAP_MAX_BYTES) {
            warn(
              `Sitemap is ${(inflated.byteLength / (1024 * 1024)).toFixed(1)} MB uncompressed, over the sitemaps.org 50 MB limit.`,
            );
          }
          xml = inflated.toString('utf8');
        } catch (err) {
          if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
            // Far past the protocol limit: a breach of it, not a broken file.
            file.reason = 'too-large';
            fail(
              `Sitemap is over ${SITEMAP_MAX_INFLATED_BYTES / (1024 * 1024)} MB uncompressed, far over the sitemaps.org 50 MB limit; not read.`,
            );
          } else {
            fail(`Corrupt gzip sitemap: ${err instanceof Error ? err.message : String(err)}`);
          }
          continue;
        }
      } else {
        xml = Buffer.from(raw).toString('utf8');
        // Only meaningful for non-gzip bodies — a gzipped sitemap that
        // inflated cleanly is self-evidently a sitemap whatever the header
        // claimed.
        if (ct && !SITEMAP_OK_CONTENT_TYPES.some((ok) => ct.includes(ok))) {
          warn(`Unexpected Content-Type "${ct}" (expected an XML type).`);
        }
      }

      const parsed = parseSitemap(xml, item.url);
      if (parsed.type === 'unknown') {
        fail('Unrecognized sitemap format');
        continue;
      }
      result.sitemapsParsed.push(item.url);
      file.urlCount = parsed.entries.length;
      file.childCount = parsed.childSitemaps.length;
      const norms = parsed.entries.map((e) => normalizeUrl(e.url, undefined, opts.rewrites));
      file.duplicateEntries =
        parsed.entries.length - new Set(norms.map((n, i) => n ?? parsed.entries[i]!.url)).size;
      // Per-file URL cap (sitemapindex children are counted individually,
      // which is exactly what the protocol limits).
      if (parsed.entries.length > SITEMAP_MAX_URLS) {
        warn(
          `Sitemap declares ${parsed.entries.length.toLocaleString('en-US')} URLs, over the sitemaps.org 50,000 limit.`,
        );
      }
      if (parsed.childSitemaps.length > SITEMAP_MAX_URLS) {
        warn(
          `Sitemap index references ${parsed.childSitemaps.length.toLocaleString('en-US')} sitemaps, over the sitemaps.org 50,000 limit.`,
        );
      }
      for (const [i, entry] of parsed.entries.entries()) {
        if (result.entries.length >= opts.maxUrls) {
          result.truncated = true;
          break;
        }
        const norm = norms[i];
        if (!norm) continue;
        result.entries.push({ ...entry, url: norm });
      }
      for (const child of parsed.childSitemaps) {
        queue.push({ url: child, depth: item.depth + 1 });
      }
    } catch (err) {
      fail(formatFetchError(err));
    }
  }
  return result;
}

/**
 * What the Validate Sitemap tools report for a walked tree: each file's own
 * warnings, and a too-large file, named by file; then the first `<lastmod>`
 * that is neither YYYY-MM-DD nor RFC 3339 among the first entries.
 */
export function validateFetchedSitemaps(result: SitemapDiscoveryResult): {
  findings: string[];
  lastmodSamples: string[];
} {
  const findings: string[] = [];
  for (const f of result.files) {
    for (const w of f.warnings) findings.push(`${f.url}: ${w}`);
    if (f.reason === 'too-large' && f.error) findings.push(`${f.url}: ${f.error}`);
  }
  const lastmodSamples = result.entries
    .slice(0, 50)
    .map((e) => e.lastmod ?? '')
    .filter(Boolean)
    .slice(0, 10);
  // The W3C subset Google accepts: YYYY-MM-DD, or full RFC 3339 / ISO 8601 with timezone.
  const lastmodRe = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
  const bad = lastmodSamples.find((sample) => !lastmodRe.test(sample));
  if (bad !== undefined) {
    findings.push(`Invalid <lastmod> value: "${bad}" (expected YYYY-MM-DD or RFC 3339).`);
  }
  return { findings, lastmodSamples };
}
