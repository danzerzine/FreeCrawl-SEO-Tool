import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { STATUS_CODES } from 'node:http';
import type { ProjectDb } from '@freecrawl/db';
import type { CrawlUrlRow, UrlCategory } from '@freecrawl/shared-types';
import { escapeCsv } from './spreadsheet.js';
import { writeUrlFilesInOnePass } from './url-files-pass.js';

/**
 * "SEO Audit" folder export in Screaming Frog's layout: the same file
 * names Screaming Frog's Bulk Export writes (`internal_all.csv`,
 * `page_titles_all.csv`, `response_codes_redirection_(3xx).csv`, …), each
 * with that file's own header row, the same row set per file and every
 * cell quoted, CRLF rows (SF 24's format). Audit spreadsheets, Looker
 * templates and scripts written against a Screaming Frog crawl read these
 * files without remapping.
 *
 * Columns FreeCrawl does not track (`CO2 (mg)`, `Spelling Errors`,
 * `HTTP rel="next" 1`) are present but empty so the header row still
 * matches. Every file is written, header-only when nothing matches.
 */

/** Screaming Frog 24's Internal tab columns, in its order. */
export const SEO_AUDIT_HEADERS = [
  'Address',
  'Content Type',
  'Status Code',
  'Status',
  'Indexability',
  'Indexability Status',
  'Title 1',
  'Title 1 Length',
  'Title 1 Pixel Width',
  'Meta Description 1',
  'Meta Description 1 Length',
  'Meta Description 1 Pixel Width',
  'Meta Keywords 1',
  'Meta Keywords 1 Length',
  'H1-1',
  'H1-1 Length',
  'H2-1',
  'H2-1 Length',
  'H2-2',
  'H2-2 Length',
  'Meta Robots 1',
  'X-Robots-Tag 1',
  'Meta Refresh 1',
  'Canonical Link Element 1',
  'rel="next" 1',
  'rel="prev" 1',
  'HTTP rel="next" 1',
  'HTTP rel="prev" 1',
  'amphtml Link Element',
  'Size (Bytes)',
  'Transferred (Bytes)',
  'Total Transferred (Bytes)',
  'CO2 (mg)',
  'Carbon Rating',
  'Word Count',
  'Sentence Count',
  'Average Words Per Sentence',
  'Flesch Reading Ease Score',
  'Readability',
  'Text Ratio',
  'Crawl Depth',
  'Folder Depth',
  'Link Score',
  'Inlinks',
  'Unique Inlinks',
  'Unique JS Inlinks',
  '% of Total',
  'Outlinks',
  'Unique Outlinks',
  'Unique JS Outlinks',
  'External Outlinks',
  'Unique External Outlinks',
  'Unique External JS Outlinks',
  'Closest Near Duplicate Match',
  'No. Near Duplicates',
  'Spelling Errors',
  'Grammar Errors',
  'Hash',
  'Response Time',
  'Last Modified',
  'Redirect URL',
  'Redirect Type',
  'Cookies',
  'Language',
  'HTTP Version',
  'Mobile Alternate Link',
  'Closest Semantically Similar Address',
  'Semantic Similarity Score',
  'No. Semantically Similar',
  'Semantic Relevance Score',
  'URL Encoded Address',
  'Crawl Timestamp',
] as const;

const RESPONSE_CODE_HEADERS = [
  'Address',
  'Content Type',
  'Status Code',
  'Status',
  'Indexability',
  'Indexability Status',
  'Inlinks',
  'Response Time',
  'Redirect URL',
  'Redirect Type',
];
const TITLE_HEADERS = [
  'Address',
  'Occurrences',
  'Title 1',
  'Title 1 Length',
  'Title 1 Pixel Width',
  'Indexability',
  'Indexability Status',
];
const META_DESCRIPTION_HEADERS = [
  'Address',
  'Occurrences',
  'Meta Description 1',
  'Meta Description 1 Length',
  'Meta Description 1 Pixel Width',
  'Indexability',
  'Indexability Status',
];
const H1_HEADERS = [
  'Address',
  'Occurrences',
  'H1-1',
  'H1-1 Length',
  'Indexability',
  'Indexability Status',
];

type Cell = string | number | null;

/** What the stored body says that the parsed columns do not keep. */
interface BodyFacts {
  /** MD5 of the body, Screaming Frog's form; null when the stored copy is not the whole body. */
  md5: string | null;
  metaDescriptions: number;
  metaRobots: number;
  /** First robots meta's `content`, case as authored (the column stores it lowercased). */
  metaRobots1: string | null;
}

/** Per-export lookups the row columns draw on, loaded once per run. */
export interface SeoAuditContext {
  /** Keyed by URL id. */
  bodies: Map<number, BodyFacts>;
  /** Keyed by URL id. */
  headers: Map<number, { lastModified?: string; contentLength?: number }>;
  external: Map<number, { total: number; unique: number }>;
}

const EMPTY_CONTEXT: SeoAuditContext = {
  bodies: new Map(),
  headers: new Map(),
  external: new Map(),
};

// Same names html-parser.ts reads as robots directives.
const ROBOTS_META_NAMES = new Set(['robots', 'googlebot', 'googlebot-news', 'bingbot']);

function metaAttrs(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s=/<>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) {
    const name = m[1]!.toLowerCase();
    if (!attrs.has(name)) attrs.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const detachedCache = new Map<string, string>();

/**
 * A copy of `s` that does not point into the string it was cut from: V8
 * keeps a substring as a view of its parent, so a robots value kept per
 * page would otherwise pin that page's whole decompressed body. The values
 * repeat across a site, so one copy serves every page.
 */
function detached(s: string): string {
  let copy = detachedCache.get(s);
  if (copy === undefined) {
    // A fresh flat string; lossless, lone surrogates included.
    copy = JSON.parse(JSON.stringify(s)) as string;
    if (detachedCache.size < 10_000) detachedCache.set(copy, copy);
  }
  return copy;
}

function bodyFacts(body: string, contentLength: number | null): BodyFacts {
  let metaDescriptions = 0;
  let metaRobots = 0;
  let metaRobots1: string | null = null;
  for (const [tag] of body.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = metaAttrs(tag);
    const name = (attrs.get('name') ?? '').trim().toLowerCase();
    if (name === 'description') metaDescriptions++;
    else if (ROBOTS_META_NAMES.has(name)) {
      metaRobots++;
      metaRobots1 ??= detached((attrs.get('content') ?? '').trim()) || null;
    }
  }
  // The stored copy is the decoded body: its UTF-8 bytes are the ones
  // fetched only when the byte count matches (no charset re-encoding,
  // no snapshot cap). Screaming Frog prints the digest as a number, so a
  // leading zero is dropped (`f4d9…` for `0f4d9…`).
  const md5 =
    contentLength !== null && Buffer.byteLength(body, 'utf8') === contentLength
      ? createHash('md5')
          .update(body, 'utf8')
          .digest('hex')
          .replace(/^0+(?=.)/, '')
      : null;
  return { md5, metaDescriptions, metaRobots, metaRobots1 };
}

/** One pass over stored bodies, headers and external links. */
export function loadSeoAuditContext(db: ProjectDb): SeoAuditContext {
  // The hash needs the stored byte count, taken only for Internal: HTML rows.
  const html = idSet(db.urlIdsByCategory('internal:html'));
  const bodies = new Map<number, BodyFacts>();
  for (const src of db.iteratePageBodies()) {
    if (!src.html) continue;
    bodies.set(src.id, bodyFacts(src.html, html.has(src.id) ? src.contentLength : null));
  }
  const headers: SeoAuditContext['headers'] = new Map();
  for (const h of db.iterateResponseHeadersNamed(['content-length', 'last-modified'])) {
    const entry = headers.get(h.urlId) ?? {};
    if (h.name === 'last-modified') entry.lastModified = h.value;
    else if (/^\d+$/.test(h.value.trim())) entry.contentLength = Number(h.value.trim());
    headers.set(h.urlId, entry);
  }
  const external = db.externalOutlinkCounts();
  return { bodies, headers, external };
}

/** Membership test over an ascending id list. */
function idSet(ids: Uint32Array): { has(id: number): boolean } {
  const max = ids.length ? ids[ids.length - 1]! : 0;
  const bits = new Uint8Array(max + 1);
  for (const id of ids) bits[id] = 1;
  return { has: (id) => id <= max && bits[id] === 1 };
}

function inRange(row: CrawlUrlRow, from: number): boolean {
  const code = row.statusCode ?? 0;
  return code >= from && code < from + 100;
}

/** Served as an HTML document (a font typed `html` by its URL is not). */
function isHtmlDocument(row: CrawlUrlRow): boolean {
  return row.contentKind === 'html' && (!row.contentType || /html/i.test(row.contentType));
}

/** The pages Screaming Frog's content tabs (titles, H1, directives of HTML…) list. */
function isHtmlPage(row: CrawlUrlRow): boolean {
  return isHtmlDocument(row) && inRange(row, 200);
}

/** HTTP reason phrase: HTTP/2 sends none, so the standard one for the code. */
function statusPhrase(row: CrawlUrlRow): string | null {
  const code = row.statusCode;
  return (code ? STATUS_CODES[code] : undefined) ?? row.statusText;
}

/** Screaming Frog's "Indexability Status" wording. */
function indexabilityStatus(row: CrawlUrlRow): string {
  if (row.indexability === 'indexable') return '';
  if (inRange(row, 300)) return 'Redirected';
  if (inRange(row, 400)) return 'Client Error';
  if (inRange(row, 500)) return 'Server Error';
  switch (row.indexability) {
    case 'non-indexable:noindex':
      return 'noindex';
    case 'non-indexable:canonical':
      return 'Canonicalised';
    case 'non-indexable:robots-blocked':
      return 'Blocked by Robots.txt';
    case 'non-indexable:redirect':
      return 'Redirected';
    case 'non-indexable:client-error':
      return 'Client Error';
    case 'non-indexable:server-error':
      return 'Server Error';
    case 'non-indexable:no-response':
      return 'No Response';
    default:
      return 'Blocked by bot protection';
  }
}

function redirectType(row: CrawlUrlRow): string {
  if (inRange(row, 300)) return 'HTTP Redirect';
  if (row.metaRefreshUrl) return 'Meta Refresh';
  if (row.jsRedirectUrl) return 'JavaScript Redirect';
  return '';
}

function redirectUrl(row: CrawlUrlRow): string | null {
  if (inRange(row, 300)) return row.redirectTarget;
  return row.metaRefreshUrl ?? row.jsRedirectUrl ?? null;
}

const h2Cache = new WeakMap<CrawlUrlRow, string[]>();

/** The page's H2 texts in source order, parsed once per row. */
function h2s(row: CrawlUrlRow): string[] {
  let list = h2Cache.get(row);
  if (list) return list;
  list = [];
  try {
    if (row.headings) {
      const all = JSON.parse(row.headings) as { level: number; text: string }[];
      list = all.filter((h) => h.level === 2).map((h) => h.text);
    }
  } catch {
    /* malformed outline: no H2s */
  }
  h2Cache.set(row, list);
  return list;
}

/** `h2` → `2`, `http/1.1` → `1.1`. */
function httpVersion(row: CrawlUrlRow): string | null {
  const p = row.httpProtocol?.toLowerCase();
  if (!p) return null;
  if (p.startsWith('http/')) return p.slice(5);
  return p.replace(/^h/, '');
}

/** Screaming Frog's folder count: `/a/b/page.html` → 2, `/page` → 0. */
function folderDepth(url: string): number {
  try {
    return Math.max(0, new URL(url).pathname.split('/').length - 2);
  } catch {
    return 0;
  }
}

/** Flesch reading ease bands, as Screaming Frog labels them. */
function readability(score: number): string {
  if (score >= 90) return 'Very Easy';
  if (score >= 80) return 'Easy';
  if (score >= 70) return 'Fairly Easy';
  if (score >= 60) return 'Normal';
  if (score >= 50) return 'Fairly Difficult';
  if (score >= 30) return 'Difficult';
  return 'Very Difficult';
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** One column's value. Lengths and counts are `0` when the element is missing, as in SF. */
function cell(column: string, row: CrawlUrlRow, ctx: SeoAuditContext): Cell {
  const body = ctx.bodies.get(row.id);
  const page = isHtmlPage(row);
  const external = ctx.external.get(row.id);
  switch (column) {
    case 'Address':
    case 'URL Encoded Address':
      return row.url;
    case 'Content Type':
      return row.contentType;
    case 'Status Code':
      return row.statusCode;
    case 'Status':
      return statusPhrase(row);
    case 'Indexability':
      return row.indexability === 'indexable' ? 'Indexable' : 'Non-Indexable';
    case 'Indexability Status':
      return indexabilityStatus(row);
    case 'Title 1':
      return row.title;
    case 'Title 1 Length':
      return row.titleLength ?? 0;
    case 'Title 1 Pixel Width':
      return row.titlePixelWidth;
    case 'Meta Description 1':
      return row.metaDescription;
    case 'Meta Description 1 Length':
      return row.metaDescriptionLength ?? 0;
    case 'Meta Description 1 Pixel Width':
      return row.metaPixelWidth;
    case 'Meta Keywords 1':
      return row.metaKeywords;
    case 'Meta Keywords 1 Length':
      return row.metaKeywords?.length ?? 0;
    case 'H1-1':
      return row.h1;
    case 'H1-1 Length':
      return row.h1Length ?? 0;
    case 'H2-1':
      return h2s(row)[0] ?? null;
    case 'H2-1 Length':
      return h2s(row)[0]?.length ?? 0;
    case 'H2-2':
      return h2s(row)[1] ?? null;
    case 'H2-2 Length':
      return h2s(row)[1]?.length ?? 0;
    case 'Meta Robots 1':
      return body?.metaRobots1 ?? row.metaRobots;
    case 'X-Robots-Tag 1':
      return row.xRobotsTag;
    case 'Meta Refresh 1':
      return row.metaRefresh;
    case 'Canonical Link Element 1':
      return row.canonical;
    case 'HTTP Canonical':
      return row.canonicalHttp;
    case 'rel="next" 1':
      return row.paginationNext;
    case 'rel="prev" 1':
      return row.paginationPrev;
    case 'amphtml Link Element':
      return row.amphtml;
    case 'Size (Bytes)':
      return row.contentLength;
    case 'Transferred (Bytes)':
      // Bytes on the wire: the body itself unless it came compressed.
      return row.contentEncoding && row.contentEncoding !== 'identity'
        ? (ctx.headers.get(row.id)?.contentLength ?? null)
        : row.contentLength;
    case 'Word Count':
      return row.wordCount ?? 0;
    case 'Sentence Count':
      return page ? row.sentenceCount : null;
    case 'Average Words Per Sentence':
      return page && row.sentenceCount > 0
        ? round3((row.wordCount ?? 0) / row.sentenceCount)
        : null;
    case 'Flesch Reading Ease Score':
      return page && row.fleschReadingEase !== null ? round3(row.fleschReadingEase) : null;
    case 'Readability':
      return page && row.fleschReadingEase !== null ? readability(row.fleschReadingEase) : null;
    case 'Text Ratio':
      return row.textCodeRatio ?? 0;
    case 'Crawl Depth':
      return row.depth;
    case 'Folder Depth':
      return folderDepth(row.url);
    case 'Link Score':
      return row.linkScore;
    case 'Inlinks':
    case 'Unique Inlinks':
      return row.inlinks;
    case 'Outlinks':
    case 'Unique Outlinks':
      return row.outlinks;
    case 'External Outlinks':
      return external?.total ?? 0;
    case 'Unique External Outlinks':
      return external?.unique ?? 0;
    case 'Hash':
      return inRange(row, 200) ? (body?.md5 ?? null) : null;
    case 'Response Time':
      return row.responseTimeMs === null || row.responseTimeMs === undefined
        ? null
        : Math.round(row.responseTimeMs) / 1000;
    case 'Last Modified':
      return ctx.headers.get(row.id)?.lastModified ?? null;
    case 'Redirect URL':
      return redirectUrl(row);
    case 'Redirect Type':
      return redirectType(row);
    case 'Language':
      return row.lang;
    case 'HTTP Version':
      return httpVersion(row);
    case 'Mobile Alternate Link':
      return row.mobileAlternate;
    case 'Crawl Timestamp':
      return row.crawledAt;
    default:
      return tabDetail(column, row);
  }
}

/** The short tabs' own columns (hreflang, structured data). */
function tabDetail(column: string, row: CrawlUrlRow): Cell {
  switch (column) {
    case 'Errors':
      return row.schemaInvalidCount + row.schemaMissingRequired;
    case 'Warnings':
      return row.schemaMissingRecommended;
    case 'Total Types':
      // Only the distinct types are stored; none means a total of 0 too.
      return row.schemaTypes ? null : 0;
    case 'Unique Types':
      return row.schemaTypes ? row.schemaTypes.split(', ').length : 0;
    case 'Type-1':
      return row.schemaTypes?.split(', ')[0] ?? null;
    case 'HTML hreflang 1':
    case 'HTML hreflang 1 URL': {
      if (!row.hreflangs) return null;
      try {
        const first = (JSON.parse(row.hreflangs) as { lang: string; href: string }[])[0];
        return (column === 'HTML hreflang 1' ? first?.lang : first?.href) ?? null;
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

/** `Occurrences` depends on the file: how many of that file's element the page has. */
function occurrences(
  of: AuditFile['occurrences'],
  row: CrawlUrlRow,
  body: BodyFacts | undefined,
): number {
  switch (of) {
    case 'title':
      return row.titleCount;
    case 'h1':
      return row.h1Count;
    case 'canonical':
      return row.canonicalCount;
    case 'hreflang':
      return row.hreflangCount;
    case 'meta-description':
      return body ? body.metaDescriptions : row.metaDescription ? 1 : 0;
    case 'meta-robots':
      return body ? body.metaRobots : row.metaRobots ? 1 : 0;
    default:
      return 0;
  }
}

/** One Internal row in Screaming Frog's column order. */
export function seoAuditRow(row: CrawlUrlRow, ctx: SeoAuditContext = EMPTY_CONTEXT): Cell[] {
  return SEO_AUDIT_HEADERS.map((c) => cell(c, row, ctx));
}

interface AuditFile {
  label: string;
  file: string;
  /** The FreeCrawl category the rows come from. */
  category: UrlCategory;
  /** Screaming Frog's header row for this file. */
  headers: readonly string[];
  /** Narrows the category to the rows Screaming Frog's tab lists. */
  keep?: (row: CrawlUrlRow) => boolean;
  /** The element `Occurrences` counts in this file. */
  occurrences?: 'title' | 'meta-description' | 'h1' | 'canonical' | 'hreflang' | 'meta-robots';
}

/** Screaming Frog Bulk Export file names → the rows and columns behind each. */
export const SEO_AUDIT_FILES: readonly AuditFile[] = [
  {
    label: 'Internal: All',
    file: 'internal_all.csv',
    category: 'internal:all',
    headers: SEO_AUDIT_HEADERS,
  },
  {
    label: 'Internal: HTML',
    file: 'internal_html.csv',
    category: 'internal:html',
    headers: SEO_AUDIT_HEADERS,
    keep: isHtmlDocument,
  },
  {
    label: 'External: All',
    file: 'external_all.csv',
    category: 'external:all',
    headers: ['Address', 'Content Type', 'Status Code', 'Status', 'Crawl Depth', 'Inlinks'],
  },
  {
    label: 'Response Codes: All',
    file: 'response_codes_all.csv',
    category: 'all',
    headers: RESPONSE_CODE_HEADERS,
  },
  {
    label: 'Response Codes: Redirection (3xx)',
    file: 'response_codes_redirection_(3xx).csv',
    category: 'status:3xx',
    headers: RESPONSE_CODE_HEADERS,
  },
  {
    label: 'Response Codes: Client Error (4xx)',
    file: 'response_codes_client_error_(4xx).csv',
    category: 'status:4xx',
    headers: RESPONSE_CODE_HEADERS,
  },
  {
    label: 'Response Codes: Server Error (5xx)',
    file: 'response_codes_server_error_(5xx).csv',
    category: 'status:5xx',
    headers: RESPONSE_CODE_HEADERS,
  },
  {
    label: 'Page Titles: All',
    file: 'page_titles_all.csv',
    category: 'internal:html',
    headers: TITLE_HEADERS,
    keep: isHtmlPage,
    occurrences: 'title',
  },
  {
    label: 'Page Titles: Missing',
    file: 'page_titles_missing.csv',
    category: 'issues:title-missing',
    headers: TITLE_HEADERS,
    keep: isHtmlPage,
    occurrences: 'title',
  },
  {
    label: 'Page Titles: Duplicate',
    file: 'page_titles_duplicate.csv',
    category: 'issues:title-duplicate',
    headers: TITLE_HEADERS,
    keep: isHtmlPage,
    occurrences: 'title',
  },
  {
    label: 'Meta Description: All',
    file: 'meta_description_all.csv',
    category: 'internal:html',
    headers: META_DESCRIPTION_HEADERS,
    keep: isHtmlPage,
    occurrences: 'meta-description',
  },
  {
    label: 'Meta Description: Missing',
    file: 'meta_description_missing.csv',
    category: 'issues:meta-missing',
    headers: META_DESCRIPTION_HEADERS,
    keep: isHtmlPage,
    occurrences: 'meta-description',
  },
  {
    label: 'Meta Description: Duplicate',
    file: 'meta_description_duplicate.csv',
    category: 'issues:meta-duplicate',
    headers: META_DESCRIPTION_HEADERS,
    keep: isHtmlPage,
    occurrences: 'meta-description',
  },
  {
    label: 'H1: All',
    file: 'h1_all.csv',
    category: 'internal:html',
    headers: H1_HEADERS,
    keep: isHtmlPage,
    occurrences: 'h1',
  },
  {
    label: 'H1: Missing',
    file: 'h1_missing.csv',
    category: 'issues:h1-missing',
    headers: H1_HEADERS,
    keep: isHtmlPage,
    occurrences: 'h1',
  },
  {
    label: 'Canonicals: All',
    file: 'canonicals_all.csv',
    category: 'internal:html',
    headers: [
      'Address',
      'Occurrences',
      'Indexability',
      'Indexability Status',
      'Canonical Link Element 1',
      'HTTP Canonical',
      'Meta Robots 1',
      'X-Robots-Tag 1',
      'rel="next" 1',
      'rel="prev" 1',
      'HTTP rel="next" 1',
      'HTTP rel="prev" 1',
    ],
    keep: isHtmlPage,
    occurrences: 'canonical',
  },
  {
    // Every URL that answered 2xx, whatever its type: X-Robots-Tag applies to files too.
    label: 'Directives: All',
    file: 'directives_all.csv',
    category: 'internal:all',
    headers: [
      'Address',
      'Occurrences',
      'Meta Robots 1',
      'X-Robots-Tag 1',
      'Meta Refresh 1',
      'Canonical Link Element 1',
      'HTTP Canonical',
      'Indexability',
      'Indexability Status',
    ],
    keep: (row) => inRange(row, 200),
    occurrences: 'meta-robots',
  },
  {
    label: 'Hreflang: All',
    file: 'hreflang_all.csv',
    category: 'internal:html',
    headers: [
      'Address',
      'Title 1',
      'Occurrences',
      'HTML hreflang 1',
      'HTML hreflang 1 URL',
      'HTTP hreflang 1',
      'HTTP hreflang 1 URL',
      'Sitemap hreflang 1',
      'Sitemap hreflang 1 URL',
      'Indexability',
      'Indexability Status',
    ],
    keep: isHtmlPage,
    occurrences: 'hreflang',
  },
  {
    label: 'Pagination: All',
    file: 'pagination_all.csv',
    category: 'internal:html',
    headers: [
      'Address',
      'Indexability',
      'Indexability Status',
      'rel="next" 1',
      'HTTP rel="next" 1',
      'rel="prev" 1',
      'HTTP rel="prev" 1',
      'Canonical Link Element 1',
      'HTTP Canonical',
      'Meta Robots 1',
      'X-Robots-Tag 1',
    ],
    keep: isHtmlPage,
  },
  {
    label: 'Structured Data: All',
    file: 'structured_data_all.csv',
    category: 'internal:html',
    headers: [
      'Address',
      'Errors',
      'Warnings',
      'Rich Result Errors',
      'Rich Result Warnings',
      'Rich Result Features',
      'Feature-1',
      'Total Types',
      'Unique Types',
      'Type-1',
      'Indexability',
      'Indexability Status',
    ],
    keep: isHtmlPage,
  },
  {
    label: 'AMP: All',
    file: 'amp_all.csv',
    category: 'tab:amp',
    headers: [
      'Address',
      'Content Type',
      'Status Code',
      'Status',
      'Indexability',
      'Indexability Status',
      'Title 1',
      'Title 1 Length',
      'Title 1 Pixel Width',
      'H1-1',
      'H1-1 Length',
      'Canonical Link Element 1',
      'Size (Bytes)',
      'Word Count',
      'Text Ratio',
      'Crawl Depth',
      'Link Score',
      'Response Time',
    ],
    keep: isHtmlPage,
  },
  {
    label: 'Security: All',
    file: 'security_all.csv',
    category: 'internal:all',
    headers: [
      'Address',
      'Content Type',
      'Status Code',
      'Status',
      'HTTP Version',
      'Indexability',
      'Indexability Status',
      'Canonical Link Element 1',
      'Meta Robots 1',
      'X-Robots-Tag 1',
    ],
  },
];

/** Names earlier versions wrote; removed so a rerun into the same folder leaves one copy. */
const LEGACY_FILES = [
  'response_codes_redirection_3xx.csv',
  'response_codes_client_error_4xx.csv',
  'response_codes_server_error_5xx.csv',
];

export interface SeoAuditExportResult {
  outputDir: string;
  files: { filePath: string; label: string; rowsWritten: number }[];
  errors: { label: string; error: string }[];
}

/** Screaming Frog quotes every cell, the header row included. */
function quoted(value: Cell): string {
  const s = escapeCsv(value);
  return s.startsWith('"') ? s : `"${s}"`;
}

/** A file's CSV line for `row`, or null when the file leaves the row out. */
function auditLine(
  f: AuditFile,
  row: CrawlUrlRow,
  ctx: SeoAuditContext,
  bodyOf: (row: CrawlUrlRow) => BodyFacts | undefined,
): string | null {
  if (f.keep && !f.keep(row)) return null;
  const cells = f.headers.map((c) =>
    c === 'Occurrences' ? occurrences(f.occurrences, row, bodyOf(row)) : cell(c, row, ctx),
  );
  return cells.map(quoted).join(',') + '\r\n';
}

/**
 * Writes the folder under `outputDir` (created when missing), each file via
 * `.part` + rename. Reads through SQLite's page cache: see `withoutMmap`.
 */
export async function runSeoAuditExport(
  db: ProjectDb,
  outputDir: string,
): Promise<SeoAuditExportResult> {
  return db.withoutMmap(() => writeSeoAudit(db, outputDir));
}

async function writeSeoAudit(db: ProjectDb, outputDir: string): Promise<SeoAuditExportResult> {
  const files: SeoAuditExportResult['files'] = [];
  const errors: SeoAuditExportResult['errors'] = [];
  const disabled = db.getDisabledIssues();
  const ctx = loadSeoAuditContext(db);
  for (const legacy of LEGACY_FILES) await rm(join(outputDir, legacy), { force: true });
  const wanted = SEO_AUDIT_FILES.filter((f) => !disabled.has(f.category));
  // The body facts of the row being written, read once for all its files.
  let bodyRow: CrawlUrlRow | undefined;
  let body: BodyFacts | undefined;
  const bodyOf = (row: CrawlUrlRow): BodyFacts | undefined => {
    if (bodyRow !== row) {
      bodyRow = row;
      body = ctx.bodies.get(row.id);
    }
    return body;
  };
  const settled = await writeUrlFilesInOnePass(
    db,
    wanted.map((f) => ({
      filePath: join(outputDir, f.file),
      category: f.category,
      head: '\ufeff' + f.headers.map(quoted).join(',') + '\r\n',
      line: (row: CrawlUrlRow) => auditLine(f, row, ctx, bodyOf),
    })),
  );
  settled.forEach((r, i) => {
    const f = wanted[i]!;
    if (r.status === 'fulfilled') {
      files.push({ filePath: join(outputDir, f.file), label: f.label, rowsWritten: r.value });
    } else {
      const err = r.reason;
      errors.push({ label: f.label, error: err instanceof Error ? err.message : String(err) });
    }
  });
  return { outputDir, files, errors };
}
