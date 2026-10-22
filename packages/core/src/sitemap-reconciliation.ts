import type { ProjectDb } from '@freecrawl/db';
import { acceptedLastModified, parseSitemapLastmod } from './sitemap-lastmod.js';

/** The row `sitemap-reconciliation` exports. */
export interface SitemapReconciliationRow {
  url: string;
  inCrawl: boolean;
  inSitemap: boolean;
  /** Empty when the crawl has no status for the URL. */
  statusCode: number | '';
  indexability: string;
  /** Raw text as in the sitemap. */
  sitemapLastmod: string;
  /** The guarded `Last-Modified` day (`acceptedLastModified`), empty when rejected or absent. */
  lastModifiedHeader: string;
  /** Sitemap lastmod day minus the guarded header day, whole days; empty unless both parse. */
  lastmodDiffDays: number | '';
  verdict: string;
  note: string;
}

interface Facts {
  inSitemap: boolean;
  hasUrlRow: boolean;
  status: number | null;
  indexability: string | null;
  sitemapLastmod: string;
  /** Both parsed lastmod days differ by more than a day. */
  differs: boolean;
  lastmodParsed: boolean;
}

/**
 * Verdicts in the order they are tried: the first rule that matches wins and
 * `ok` is last. The order is the point: a sitemap URL that was never fetched
 * must not be claimed by a rule about fetched pages, a redirect must not be
 * called non-indexable, and a lastmod difference only counts on a page that
 * is otherwise fine. The same wording as the sitemap issues
 * (`redirect-in-sitemap`: 3xx; `crawled-not-in-sitemap`: 2xx and indexable).
 */
const RULES: { verdict: string; note?: (f: Facts) => string; when: (f: Facts) => boolean }[] = [
  {
    verdict: 'sitemap-not-fetched',
    note: (f) => (f.hasUrlRow ? 'queued-or-blocked' : 'not-in-crawl'),
    when: (f) => f.inSitemap && (!f.hasUrlRow || f.status === null),
  },
  {
    verdict: 'redirect-in-sitemap',
    when: (f) => f.inSitemap && f.status! >= 300 && f.status! < 400,
  },
  {
    verdict: 'non-200-in-sitemap',
    when: (f) => f.inSitemap && !(f.status! >= 200 && f.status! < 300),
  },
  {
    verdict: 'non-indexable-in-sitemap',
    when: (f) => f.inSitemap && f.indexability !== 'indexable',
  },
  {
    verdict: 'crawled-not-in-sitemap',
    when: (f) =>
      !f.inSitemap && f.status! >= 200 && f.status! < 300 && f.indexability === 'indexable',
  },
  { verdict: 'not-in-sitemap-expected', when: (f) => !f.inSitemap },
  { verdict: 'lastmod-missing', when: (f) => f.sitemapLastmod.trim() === '' },
  {
    verdict: 'lastmod-missing',
    note: () => 'lastmod-unparsable',
    when: (f) => !f.lastmodParsed,
  },
  { verdict: 'lastmod-differs', when: (f) => f.differs },
  { verdict: 'ok', when: () => true },
];

const DAY_MS = 86_400_000;

/** One row per URL of the crawl and the sitemap, with its verdict. */
export function* sitemapReconciliationRows(
  db: ProjectDb,
  now = Date.now(),
): Generator<SitemapReconciliationRow> {
  for (const r of db.iterateSitemapReconciliation()) {
    const raw = r.sitemapLastmod ?? '';
    const declared = raw.trim() === '' ? null : parseSitemapLastmod(raw);
    const header = acceptedLastModified(r.headers, r.crawledAt, now);
    const diffDays =
      declared && header
        ? Math.round((Date.parse(declared.day) - Date.parse(header.day)) / DAY_MS)
        : null;
    const facts: Facts = {
      inSitemap: r.inSitemap,
      hasUrlRow: r.hasUrlRow,
      status: r.statusCode,
      indexability: r.indexability,
      sitemapLastmod: raw,
      differs: diffDays !== null && Math.abs(diffDays) > 1,
      lastmodParsed: declared !== null,
    };
    const rule = RULES.find((x) => x.when(facts))!;
    yield {
      url: r.url,
      inCrawl: r.inCrawl,
      inSitemap: r.inSitemap,
      statusCode: r.statusCode ?? '',
      indexability: r.indexability ?? '',
      sitemapLastmod: raw,
      lastModifiedHeader: header?.day ?? '',
      lastmodDiffDays: diffDays ?? '',
      verdict: rule.verdict,
      note: rule.note?.(facts) ?? '',
    };
  }
}
