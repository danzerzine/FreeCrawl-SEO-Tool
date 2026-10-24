/**
 * Every number the audit report (`--what audit`) shows, computed from one
 * project: the crawled HTML pages, the pages open to search, the checks
 * with their reach and impact, click depth from the start page, server
 * response, title and description lengths, the sitemap, sections, a 0-100
 * health score (this report only) and, when search traffic was pulled,
 * pages against search visits per section.
 */

import type { ProjectDb } from '@freecrawl/db';
import { PAGE_LIMIT_HIT_META_KEY } from '@freecrawl/db';
import {
  ISSUE_GROUPS,
  type CrawlConfig,
  type SeoThresholds,
  type UrlCategory,
} from '@freecrawl/shared-types';
import { issueSummaryCounts } from '../report-export.js';
import type { AuditSeverity } from './texts.js';

export interface AuditIssue {
  key: UrlCategory;
  /** Catalog label, thresholds filled in. */
  label: string;
  /** Catalog group label (English). */
  group: string;
  severity: AuditSeverity;
  /** Pages with the issue, as issues-summary.csv counts them. */
  urls: number;
  /** Of those, crawled HTML pages. */
  urlsHtml: number;
  /** Of those, pages open to search. */
  urlsIndexable: number;
  /** Share of crawled HTML pages; null when no HTML page is listed. */
  share: number | null;
  /** On at least 90% of the crawled HTML pages: one template fix. */
  templateWide: boolean;
  /** Severity weight × pages open to search (else all pages): the sort key. */
  impact: number;
  /** Up to three page URLs, most linked first, pages open to search first. */
  examples: string[];
}

export interface AuditSection {
  /** `/first-segment/`, or `/` for the root. */
  section: string;
  pages: number;
  indexable: number;
  withCritical: number;
  medianMs: number | null;
}

export interface AuditTrafficRow {
  section: string;
  /** Pages open to search in the section. */
  indexable: number;
  /** Share of all pages open to search. */
  indexableShare: number;
  /** Search visits (or clicks) landing on the section. */
  visits: number;
  visitsShare: number;
  /** Pages open to search in the section with no search visit in the period. */
  zeroVisitPages: number;
  /** Whether the crawl has pages in this section at all. */
  crawled: boolean;
}

export interface AuditTraffic {
  source: 'metrica' | 'gsc';
  /** `YYYY-MM-DD`, when the pull recorded its window. */
  periodStart: string | null;
  periodEnd: string | null;
  totalVisits: number;
  /** Visits landing on URLs the crawl does not have. */
  uncrawledVisits: number;
  /** Section with the most uncrawled visits, if any. */
  uncrawledTop: { section: string; visits: number } | null;
  /** Sorted by the gap between page share and visit share, largest first. */
  rows: AuditTrafficRow[];
}

export interface AuditData {
  host: string;
  startUrl: string;
  crawlFirst: string | null;
  crawlLast: string | null;
  settings: { maxUrls: number | null; respectRobotsTxt: boolean | null; userAgent: string | null };
  thresholds: SeoThresholds;
  totals: { html: number; indexable: number; allUrls: number };
  /** HTTP status class (`200`, `300`, …; `0` for no answer) → pages. */
  status: Record<string, number>;
  /** Why pages are closed to search, most common first. */
  nonIndexable: { reason: string; count: number }[];
  /** Pages by clicks from the start page: index 0..5, then 6+ at index 6. */
  clickDepth: number[];
  /** Pages no link path from the start page reaches. */
  orphans: number;
  response: { median: number | null; p90: number | null; max: number | null };
  /** Pages open to search by title / description length against the project thresholds. */
  titles: LengthBuckets;
  descriptions: LengthBuckets;
  sitemap: {
    inSitemap: number;
    inSitemapNotCrawled: number;
    indexableNotInSitemap: number;
    nonIndexableInSitemap: number;
  };
  /** Checks with at least one page, by impact then reach. */
  issues: AuditIssue[];
  severityCounts: Record<AuditSeverity, number>;
  score: {
    /** Mean page score over pages open to search; null without such pages. */
    pageMean: number | null;
    /** −15 per template-wide critical check, −5 per template-wide warning. */
    templatePenalty: number;
    /** What the ring shows: max(0, round(pageMean) − templatePenalty). */
    value: number | null;
  };
  /** Top 15 by pages. */
  sections: AuditSection[];
  /** Catalog groups whose checks ran and found no critical or warning issue. */
  cleanGroups: string[];
  /** The crawl stopped at its page limit. */
  limitHit: boolean;
  pageLimit: number | null;
  traffic: AuditTraffic | null;
}

export interface LengthBuckets {
  ok: number;
  long: number;
  short: number;
  missing: number;
}

export interface AuditDataOptions {
  /** The crawl's config, when known: page limit, robots.txt, user agent. */
  crawlConfig?: Partial<CrawlConfig>;
}

const WEIGHT: Record<AuditSeverity, number> = { critical: 1, warning: 0.4, info: 0 };
const TEMPLATE_COST: Record<AuditSeverity, number> = { critical: 15, warning: 5, info: 0 };
/** Share of HTML pages from which a check counts as one template fix. */
export const TEMPLATE_WIDE_SHARE = 0.9;

/** `/first-segment/` of a URL's path, `/` for the root. */
export function sectionOf(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return '/';
  }
  const seg = path.split('/').find((s) => s !== '');
  return seg === undefined ? '/' : `/${seg}/`;
}

/** Value at `p` in an ascending list: element ⌊p·n⌋ (no interpolation). */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const bareHost = (h: string): string => h.replace(/^www\./, '');

function readJsonMeta(db: ProjectDb, key: string): Record<string, unknown> | null {
  const raw = db.getMeta(key);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function lengthBuckets(values: (number | null)[], min: number, max: number): LengthBuckets {
  const b: LengthBuckets = { ok: 0, long: 0, short: 0, missing: 0 };
  for (const v of values) {
    if (!v) b.missing++;
    else if (v < min) b.short++;
    else if (v > max) b.long++;
    else b.ok++;
  }
  return b;
}

/**
 * Pages by clicks from the start page: BFS over internal hyperlinks. The
 * stored `depth` is 0 for every URL seeded from a sitemap, so it cannot
 * say how many clicks a page is from the home page. Index 6 holds 6+.
 */
export function clickDepthFrom(
  startUrl: string,
  byUrl: ReadonlyMap<string, number>,
  links: Iterable<{ fromId: number; toUrl: string }>,
): { clickDepth: number[]; orphans: number } {
  const adj = new Map<number, Set<number>>();
  for (const { fromId, toUrl } of links) {
    const to = byUrl.get(toUrl);
    if (to === undefined) continue;
    let set = adj.get(fromId);
    if (!set) adj.set(fromId, (set = new Set()));
    set.add(to);
  }
  const root = byUrl.get(startUrl) ?? byUrl.get(startUrl.replace(/\/+$/, '') + '/');
  const click = new Map<number, number>();
  if (root !== undefined) {
    click.set(root, 0);
    const queue = [root];
    for (let i = 0; i < queue.length; i++) {
      const u = queue[i]!;
      const d = click.get(u)!;
      for (const v of adj.get(u) ?? []) {
        if (!click.has(v)) {
          click.set(v, d + 1);
          queue.push(v);
        }
      }
    }
  }
  const clickDepth = [0, 0, 0, 0, 0, 0, 0];
  for (const d of click.values()) clickDepth[Math.min(d, 6)]!++;
  return { clickDepth, orphans: byUrl.size - click.size };
}

/**
 * Health score: per page open to search, 100 − 50 per critical − 10 per
 * warning, floor 0, then the mean; template-wide checks are left out of
 * the pages and charged once for the site instead (critical −15, warning −5).
 */
export function healthScore(
  issues: readonly { key: string; severity: AuditSeverity; templateWide: boolean }[],
  idsOf: ReadonlyMap<string, readonly number[]>,
  indexable: ReadonlySet<number>,
): { score: AuditData['score']; crit: Map<number, number> } {
  const crit = new Map<number, number>();
  const warn = new Map<number, number>();
  for (const it of issues) {
    if (it.templateWide || it.severity === 'info') continue;
    const into = it.severity === 'critical' ? crit : warn;
    for (const id of idsOf.get(it.key) ?? [])
      if (indexable.has(id)) into.set(id, (into.get(id) ?? 0) + 1);
  }
  let pageMean: number | null = null;
  if (indexable.size > 0) {
    let sum = 0;
    for (const id of indexable)
      sum += Math.max(0, 100 - 50 * (crit.get(id) ?? 0) - 10 * (warn.get(id) ?? 0));
    pageMean = sum / indexable.size;
  }
  const templatePenalty = issues.reduce(
    (s, it) => s + (it.templateWide ? TEMPLATE_COST[it.severity] : 0),
    0,
  );
  return {
    score: {
      pageMean,
      templatePenalty,
      value: pageMean === null ? null : Math.max(0, Math.round(pageMean) - templatePenalty),
    },
    crit,
  };
}

export function buildAuditData(db: ProjectDb, options: AuditDataOptions = {}): AuditData {
  const cfg = options.crawlConfig ?? {};
  const pages = db.auditReportPages();
  const N = pages.length;
  const byId = new Map(pages.map((p) => [p.id, p]));
  const byUrl = new Map(pages.map((p) => [p.url, p.id]));
  const indexable = new Set(pages.filter((p) => p.indexability === 'indexable').map((p) => p.id));
  const I = indexable.size;

  const startUrl = db.getMeta('startUrl') || db.getMeta('lastStartUrl') || pages[0]?.url || '';
  const thresholds = db.getSeoThresholds();

  let crawlFirst: string | null = null;
  let crawlLast: string | null = null;
  const status: Record<string, number> = {};
  const reasons = new Map<string, number>();
  for (const p of pages) {
    if (crawlFirst === null || p.crawledAt < crawlFirst) crawlFirst = p.crawledAt;
    if (crawlLast === null || p.crawledAt > crawlLast) crawlLast = p.crawledAt;
    const cls = String(p.statusCode ? Math.floor(p.statusCode / 100) * 100 : 0);
    status[cls] = (status[cls] ?? 0) + 1;
    if (p.indexability !== 'indexable') {
      const r = (p.indexability || 'unknown').replace(/^non-indexable:/, '');
      reasons.set(r, (reasons.get(r) ?? 0) + 1);
    }
  }
  const nonIndexable = [...reasons]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const { clickDepth, orphans } = clickDepthFrom(startUrl, byUrl, db.auditReportHyperlinks());

  const rt = pages
    .map((p) => p.responseTimeMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const response = {
    median: percentile(rt, 0.5),
    p90: percentile(rt, 0.9),
    max: rt.at(-1) ?? null,
  };

  const idxPages = pages.filter((p) => indexable.has(p.id));
  const titles = lengthBuckets(
    idxPages.map((p) => p.titleLength),
    thresholds.titleMinChars,
    thresholds.titleMaxChars,
  );
  const descriptions = lengthBuckets(
    idxPages.map((p) => p.descriptionLength),
    thresholds.descriptionMinChars,
    thresholds.descriptionMaxChars,
  );

  // Checks: the issue summary's counts, page ids from the checks' own predicates.
  const summary = issueSummaryCounts(db);
  const issues: AuditIssue[] = [];
  const idsOf = new Map<string, number[]>();
  for (const row of summary) {
    if (!row.urls) continue;
    let all: Uint32Array;
    try {
      all = db.urlIdsByCategory(row.category);
    } catch {
      all = new Uint32Array();
    }
    const ids = [...all].filter((id) => byId.has(id)).sort((a, b) => a - b);
    idsOf.set(row.category, ids);
    const idx = ids.filter((id) => indexable.has(id));
    const inl = (id: number): number => byId.get(id)?.inlinks ?? 0;
    const examples = [...(idx.length ? idx : ids)]
      .sort((a, b) => inl(b) - inl(a))
      .slice(0, 3)
      .map((id) => byId.get(id)!.url);
    const severity: AuditSeverity =
      row.severity === 'critical' || row.severity === 'warning' ? row.severity : 'info';
    const share = ids.length && N ? ids.length / N : null;
    issues.push({
      key: row.category,
      label: row.label,
      group: row.group,
      severity,
      urls: row.urls,
      urlsHtml: ids.length,
      urlsIndexable: idx.length,
      share,
      templateWide: share !== null && share >= TEMPLATE_WIDE_SHARE,
      impact: Math.round(WEIGHT[severity] * (idx.length || row.urls) * 10) / 10,
      examples,
    });
  }
  issues.sort((a, b) => b.impact - a.impact || b.urls - a.urls);

  const severityCounts: Record<AuditSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const it of issues) severityCounts[it.severity]++;

  const { score, crit } = healthScore(issues, idsOf, indexable);

  const secMap = new Map<
    string,
    { pages: number; indexable: number; withCritical: number; rt: number[] }
  >();
  for (const p of pages) {
    const key = sectionOf(p.url);
    let s = secMap.get(key);
    if (!s) secMap.set(key, (s = { pages: 0, indexable: 0, withCritical: 0, rt: [] }));
    s.pages++;
    if (indexable.has(p.id)) {
      s.indexable++;
      if (crit.has(p.id)) s.withCritical++;
    }
    if (p.responseTimeMs !== null) s.rt.push(p.responseTimeMs);
  }
  const sections = [...secMap]
    .map(([section, s]) => ({
      section,
      pages: s.pages,
      indexable: s.indexable,
      withCritical: s.withCritical,
      medianMs: median(s.rt),
    }))
    .sort((a, b) => b.pages - a.pages)
    .slice(0, 15);

  // «Checked, fine»: groups whose checks ran (some count is known) and
  // found no critical or warning issue.
  const counted = new Map(summary.map((r) => [r.category, r]));
  const flagged = new Set(issues.filter((it) => it.severity !== 'info').map((it) => it.group));
  const cleanGroups = ISSUE_GROUPS.filter(
    (g) =>
      !flagged.has(g.label) &&
      g.items.some((i) => (counted.get(i.category)?.urls ?? null) !== null),
  )
    .map((g) => g.label)
    .sort((a, b) => a.localeCompare(b, 'en'));

  const sitemap = db.auditReportSitemap();
  const limitMeta = Number(db.getMeta(PAGE_LIMIT_HIT_META_KEY));
  const cfgLimit = typeof cfg.maxUrls === 'number' && cfg.maxUrls > 0 ? cfg.maxUrls : null;
  const pageLimit = limitMeta > 0 ? limitMeta : cfgLimit;
  const limitHit = limitMeta > 0 || (cfgLimit !== null && N + 10 >= cfgLimit);

  return {
    host: hostOf(startUrl),
    startUrl,
    crawlFirst,
    crawlLast,
    settings: {
      maxUrls: pageLimit,
      respectRobotsTxt: typeof cfg.respectRobotsTxt === 'boolean' ? cfg.respectRobotsTxt : null,
      userAgent: typeof cfg.userAgent === 'string' && cfg.userAgent ? cfg.userAgent : null,
    },
    thresholds,
    totals: { html: N, indexable: I, allUrls: db.countInternalUrls() },
    status,
    nonIndexable,
    clickDepth,
    orphans,
    response,
    titles,
    descriptions,
    sitemap,
    issues,
    severityCounts,
    score,
    sections,
    cleanGroups,
    limitHit,
    pageLimit,
    traffic: buildTraffic(db, pages, indexable, hostOf(startUrl)),
  };
}

/** Pages against search visits per section; null when no search traffic was pulled. */
function buildTraffic(
  db: ProjectDb,
  pages: { id: number; url: string }[],
  indexable: ReadonlySet<number>,
  host: string,
): AuditTraffic | null {
  const pulled = db.auditReportSearchTraffic();
  if (!pulled) return null;
  const site = bareHost(host);
  const rows = pulled.rows.filter((r) => !site || bareHost(hostOf(r.url)) === site);
  if (rows.length === 0) return null;

  const crawled = new Set(pages.map((p) => p.url));
  const visitsByUrl = new Map<string, number>();
  for (const r of rows) visitsByUrl.set(r.url, (visitsByUrl.get(r.url) ?? 0) + r.value);
  const visitsOf = (url: string): number =>
    visitsByUrl.get(url) ?? visitsByUrl.get(url.endsWith('/') ? url.slice(0, -1) : `${url}/`) ?? 0;
  const known = (url: string): boolean =>
    crawled.has(url) || crawled.has(url.endsWith('/') ? url.slice(0, -1) : `${url}/`);

  const sec = new Map<
    string,
    { indexable: number; visits: number; zero: number; crawled: boolean }
  >();
  const get = (k: string) => {
    let s = sec.get(k);
    if (!s) sec.set(k, (s = { indexable: 0, visits: 0, zero: 0, crawled: false }));
    return s;
  };
  for (const p of pages) {
    const s = get(sectionOf(p.url));
    s.crawled = true;
    if (!indexable.has(p.id)) continue;
    s.indexable++;
    if (visitsOf(p.url) === 0) s.zero++;
  }
  let total = 0;
  let uncrawled = 0;
  const uncrawledBySec = new Map<string, number>();
  for (const [url, v] of visitsByUrl) {
    total += v;
    const k = sectionOf(url);
    get(k).visits += v;
    if (!known(url)) {
      uncrawled += v;
      uncrawledBySec.set(k, (uncrawledBySec.get(k) ?? 0) + v);
    }
  }
  const I = indexable.size;
  const out = [...sec]
    .map(([section, s]) => ({
      section,
      indexable: s.indexable,
      indexableShare: I ? s.indexable / I : 0,
      visits: s.visits,
      visitsShare: total ? s.visits / total : 0,
      zeroVisitPages: s.zero,
      crawled: s.crawled,
    }))
    .filter((r) => r.indexable > 0 || r.visits > 0)
    .sort(
      (a, b) =>
        Math.abs(b.indexableShare - b.visitsShare) - Math.abs(a.indexableShare - a.visitsShare) ||
        b.visits - a.visits,
    );
  let uncrawledTop: AuditTraffic['uncrawledTop'] = null;
  for (const [section, visits] of uncrawledBySec) {
    if (!uncrawledTop || visits > uncrawledTop.visits) uncrawledTop = { section, visits };
  }

  const meta =
    readJsonMeta(
      db,
      `${pulled.source === 'metrica' ? 'metricaFetchMeta' : 'gscFetchMeta'}:${pulled.accountId}`,
    ) ?? readJsonMeta(db, pulled.source === 'metrica' ? 'metricaFetchMeta' : 'gscFetchMeta');
  const date = (v: unknown): string | null =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  return {
    source: pulled.source,
    periodStart: date(meta?.['startDate']),
    periodEnd: date(meta?.['endDate']),
    totalVisits: total,
    uncrawledVisits: uncrawled,
    uncrawledTop,
    rows: out,
  };
}
