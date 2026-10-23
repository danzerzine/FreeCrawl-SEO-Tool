import type { ProjectDb } from '@freecrawl/db';
import type {
  AiProvider,
  ExportDatasetKey,
  GscRow,
  LinkSuggestionRow,
} from '@freecrawl/shared-types';
import { extractVisibleText } from './html-parser.js';
import { registrableDomain } from './url-utils.js';
import { sitemapReconciliationRows } from './sitemap-reconciliation.js';
import { topWordsBlocks, type TopWordsBlocksOptions } from './top-words-db.js';

/**
 * Row sources for the non-URL-row export tables (see `ExportDatasetKey`).
 *
 * Every dataset already has a paged query on `ProjectDb` that the matching
 * tab reads through IPC; the exporter walks the same query to its end so
 * the file holds the whole table, not the first screenful the tab happened
 * to load. Rows are yielded as the query returns them — nested (`gsc`,
 * `mobile`, `seo.metrics`) — and the writers read the dotted column keys
 * from `EXPORT_DATASET_COLUMNS` straight off that shape.
 */

/** Per-host context the datasets that are keyed by account need. */
export interface DatasetExportContext {
  /** Linked Google account whose Search Console pull to export. */
  gscAccountId?: string;
  /** Linked Google account whose GA4 pull to export. */
  ga4AccountId?: string;
  /** Yandex Metrica counter whose pull to export. */
  metricaCounterId?: string;
  /** Yandex Webmaster host whose pull to export; without it nothing is exported. */
  webmasterHostId?: string;
  /** Search Console URL-matching options (Settings → Integrations → GSC). */
  gscMatchSlash?: boolean;
  gscMatchCase?: boolean;
  /** Issue whose inlinks the `issue-inlinks` dataset holds; every issue when unset. */
  issueKey?: string;
  /** Pages whose links the `selected-inlinks` / `selected-outlinks` datasets hold. */
  urls?: string[];
  /** The same pages by id; resolved to URLs and added to `urls`. */
  urlIds?: number[];
  /** Options of the `top-words` dataset (CLI `--ngram`, `--word-locale`, `--by-section`, ...). */
  topWords?: TopWordsBlocksOptions;
  /** The `link-suggestions` dataset's rows, computed once by the caller (it also needs the flags of the run). */
  linkSuggestions?: LinkSuggestionRow[];
}

const PAGE_SIZE = 2000;

function* paged<T>(
  fetchPage: (limit: number, offset: number) => { rows: T[] },
  pageSize = PAGE_SIZE,
): Generator<T> {
  let offset = 0;
  for (;;) {
    const { rows } = fetchPage(pageSize, offset);
    for (const row of rows) yield row;
    if (rows.length < pageSize) return;
    offset += pageSize;
  }
}

/** The chosen pages as URLs, `urls` first then the resolved `urlIds`, without repeats. */
function selectedUrls(db: ProjectDb, ctx: DatasetExportContext): string[] {
  const out = new Set(ctx.urls ?? []);
  for (const id of ctx.urlIds ?? []) {
    const row = db.getUrlRowById(id);
    if (row) out.add(row.url);
  }
  return [...out];
}

/**
 * Page text is not stored on its own: it is the visible text of the stored
 * body (the rendered DOM when the crawl rendered the page). Pages whose
 * body holds no text are left out.
 */
function* pageTexts(db: ProjectDb): Generator<Record<string, unknown>> {
  for (const page of db.iteratePageSources()) {
    const text = extractVisibleText(page.renderedHtml ?? page.html);
    if (text.length > 0) yield { url: page.url, text };
  }
}

/** One row per word or phrase of each block; blocks and rows come ordered (section, count desc, gram). */
function* topWordsDatasetRows(
  db: ProjectDb,
  opts: TopWordsBlocksOptions,
): Generator<Record<string, unknown>> {
  // 1000 rows per block is the aggregator's hard cap; the CLI asks for all of them.
  for (const block of topWordsBlocks(db, { limit: 1000, ...opts })) {
    for (const r of block.rows) {
      yield {
        scope: block.scope,
        section: block.section,
        n: block.n,
        gram: r.word,
        count: r.count,
        pages: r.pages,
        capped: block.capped ? 'true' : 'false',
      };
    }
  }
}

const JOIN = ' | ';

/**
 * The URL Inspection lists become flat cells (the column list stays static): sitemaps,
 * referring pages, rich-result types and messages are joined with ` | `; the error and warning
 * cells count the items that have any. A page never inspected, or inspected before these
 * fields existed, gets null cells, never an empty list.
 */
function* flattenInspection(rows: Iterable<GscRow>): Generator<Record<string, unknown>> {
  for (const row of rows) {
    const i = row.inspection;
    if (!i) {
      yield row as unknown as Record<string, unknown>;
      continue;
    }
    const rich = i.richResults ?? null;
    const items = rich ? rich.flatMap((t) => t.items) : [];
    yield {
      ...row,
      inspection: {
        ...i,
        sitemaps: i.sitemaps ? i.sitemaps.join(JOIN) : null,
        referringUrls: i.referringUrls ? i.referringUrls.join(JOIN) : null,
        richResultTypes: rich ? rich.map((t) => t.type).join(JOIN) : null,
        richResultErrors: rich ? items.filter((it) => it.errors > 0).length : null,
        richResultWarnings: rich ? items.filter((it) => it.warnings > 0).length : null,
        richResultMessages: rich ? items.flatMap((it) => it.messages).join(JOIN) : null,
      },
    };
  }
}

const IP_HOST = /^(\d{1,3}(\.\d{1,3}){3}|\[.*\])$/;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Cross-site by registrable domain; an IP or a bare host only matches itself. */
function isThirdPartyCookie(cookieDomain: string, pageUrl: string): boolean {
  const page = hostOf(pageUrl).toLowerCase();
  const dom = cookieDomain.toLowerCase();
  if (!page || !dom) return false;
  if (IP_HOST.test(page) || IP_HOST.test(dom) || !page.includes('.') || !dom.includes('.')) {
    return page !== dom;
  }
  return registrableDomain(page) !== registrableDomain(dom);
}

/** One row per cookie of a page's list: expires as ISO text, 'session' or empty. */
function* cookieRows(db: ProjectDb): Iterable<Record<string, unknown>> {
  for (const c of db.iterateCookies()) {
    yield {
      ...c,
      expires:
        c.expires === null ? null : c.expires < 0 ? 'session' : new Date(c.expires * 1000).toISOString(),
      thirdParty: isThirdPartyCookie(c.domain, c.url),
    };
  }
}

export function datasetRows(
  db: ProjectDb,
  dataset: ExportDatasetKey,
  ctx: DatasetExportContext = {},
): Iterable<Record<string, unknown>> {
  const asRecords = <T>(gen: Iterable<T>): Iterable<Record<string, unknown>> =>
    gen as Iterable<unknown> as Iterable<Record<string, unknown>>;
  switch (dataset) {
    case 'images':
      return asRecords(paged((limit, offset) => db.queryImages({ limit, offset })));
    case 'broken-links':
      // Streamed: paging re-sorted the whole join and ran a COUNT(*) on
      // every page.
      return asRecords(db.iterateBrokenLinks('all'));
    case 'broken-links-by-target':
      return asRecords(db.iterateBrokenLinksByTarget());
    case 'issues-long':
      return asRecords(db.iterateIssuesLong());
    case 'page-signals':
      return asRecords(db.iteratePageSignals());
    case 'issue-inlinks':
      return asRecords(db.iterateIssueInlinks(ctx.issueKey));
    case 'selected-inlinks':
      return asRecords(db.iterateSelectedInlinks(selectedUrls(db, ctx)));
    case 'selected-outlinks':
      return asRecords(db.iterateSelectedOutlinks(selectedUrls(db, ctx)));
    case 'response-headers':
      return asRecords(db.iterateResponseHeaders());
    case 'page-html':
      return asRecords(db.iteratePageSources());
    case 'page-text':
      return pageTexts(db);
    case 'sitemap-urls':
      return asRecords(db.iterateSitemapUrls());
    case 'sitemap-reconciliation':
      return asRecords(sitemapReconciliationRows(db));
    case 'sitemap-files':
      return asRecords(
        (function* () {
          for (const f of db.iterateSitemapFiles())
            yield { ...f, warnings: f.warnings.join(' | ') };
        })(),
      );
    case 'cookies':
      return asRecords(cookieRows(db));
    case 'crawl-queue':
      return asRecords(db.iterateCrawlQueue());
    case 'pagespeed':
      return asRecords(paged((limit, offset) => db.queryPagespeed({ limit, offset })));
    case 'pagespeed-audits':
      return asRecords(
        (function* () {
          for (const row of paged((limit, offset) => db.queryPagespeedAudits({ limit, offset })))
            yield {
              ...row,
              resourcesCount: row.items.length,
              resourcesJson: JSON.stringify(row.items),
            };
        })(),
      );
    case 'axe-violations':
      return asRecords(
        (function* () {
          for (const row of db.iterateAxeResults())
            yield {
              url: row.url,
              ruleId: row.ruleId,
              kind: row.kind === 'violation' ? 'violation' : 'needs-review',
              impact: row.impact,
              help: row.help,
              helpUrl: row.helpUrl,
              tags: row.tags.join(','),
              nodes: row.nodes,
              firstSelector: row.samples[0]?.target ?? null,
              firstHtml: row.samples[0]?.html ?? null,
            };
        })(),
      );
    case 'link-suggestions':
      return (function* () {
        for (const r of ctx.linkSuggestions ?? []) {
          yield { ...r, sameSection: r.sameSection === null ? null : r.sameSection ? 'yes' : 'no' };
        }
      })();
    case 'top-words':
      return topWordsDatasetRows(db, ctx.topWords ?? {});
    case 'crux':
      return asRecords(paged((limit, offset) => db.queryCrux({ limit, offset })));
    case 'spelling':
      return asRecords(paged((limit, offset) => db.querySpelling({ limit, offset })));
    case 'search-console':
      return asRecords(
        flattenInspection(
          paged((limit, offset) =>
            db.queryGsc({
              limit,
              offset,
              accountId: ctx.gscAccountId,
              matchSlash: ctx.gscMatchSlash,
              matchCase: ctx.gscMatchCase,
            }),
          ),
        ),
      );
    case 'analytics':
      return asRecords(
        paged((limit, offset) => db.queryGa4({ limit, offset, accountId: ctx.ga4AccountId })),
      );
    case 'analytics-custom':
      return asRecords(db.iterateGa4CustomLong(ctx.ga4AccountId ?? ''));
    case 'metrica':
      // queryMetrica caps a page at 1000 rows; a larger page would read as
      // the last one.
      return asRecords(
        paged(
          (limit, offset) => db.queryMetrica({ limit, offset, counterId: ctx.metricaCounterId }),
          1000,
        ),
      );
    case 'webmaster':
      return asRecords(
        paged(
          (limit, offset) =>
            db.queryWebmasterExcluded({ hostId: ctx.webmasterHostId ?? '', limit, offset }),
          1000,
        ),
      );
    case 'webmaster-broken-links':
      return asRecords(
        paged(
          (limit, offset) =>
            db.queryWebmasterBrokenLinks({ hostId: ctx.webmasterHostId ?? '', limit, offset }),
          1000,
        ),
      );
    default: {
      // Provider-keyed datasets: `ai:<provider>` / `seo:<provider>`.
      const sep = dataset.indexOf(':');
      const family = dataset.slice(0, sep);
      const provider = dataset.slice(sep + 1);
      if (family === 'ai') {
        return asRecords(
          paged((limit, offset) =>
            db.queryAi({ limit, offset, provider: provider as AiProvider }),
          ),
        );
      }
      if (family === 'seo') {
        return asRecords(
          paged((limit, offset) =>
            db.querySeo({
              limit,
              offset,
              provider: provider as 'ahrefs' | 'majestic' | 'moz' | 'semrush',
            }),
          ),
        );
      }
      throw new Error(`exportTabular: unknown dataset '${dataset as string}'`);
    }
  }
}

/**
 * Read one export cell. Column keys are dotted paths (`gsc.clicks`) so a
 * dataset row's nested result objects export as flat columns; a missing
 * intermediate (`gsc: null` — no Search Console data for the page) reads
 * as an empty cell instead of throwing on the row.
 */
export function readCell(row: Record<string, unknown>, key: string): unknown {
  if (key.indexOf('.') < 0) return row[key];
  let cur: unknown = row;
  for (const part of key.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur ?? null;
}
