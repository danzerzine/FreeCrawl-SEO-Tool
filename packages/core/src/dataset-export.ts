import type { ProjectDb } from '@freecrawl/db';
import type { ExportDatasetKey } from '@freecrawl/shared-types';
import { extractVisibleText } from './html-parser.js';
import { sitemapReconciliationRows } from './sitemap-reconciliation.js';

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
  /** Search Console URL-matching options (Settings → Integrations → GSC). */
  gscMatchSlash?: boolean;
  gscMatchCase?: boolean;
  /** Issue whose inlinks the `issue-inlinks` dataset holds; every issue when unset. */
  issueKey?: string;
  /** Pages whose links the `selected-inlinks` / `selected-outlinks` datasets hold. */
  urls?: string[];
  /** The same pages by id; resolved to URLs and added to `urls`. */
  urlIds?: number[];
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
    case 'crawl-queue':
      return asRecords(db.iterateCrawlQueue());
    case 'pagespeed':
      return asRecords(paged((limit, offset) => db.queryPagespeed({ limit, offset })));
    case 'crux':
      return asRecords(paged((limit, offset) => db.queryCrux({ limit, offset })));
    case 'spelling':
      return asRecords(paged((limit, offset) => db.querySpelling({ limit, offset })));
    case 'search-console':
      return asRecords(
        paged((limit, offset) =>
          db.queryGsc({
            limit,
            offset,
            accountId: ctx.gscAccountId,
            matchSlash: ctx.gscMatchSlash,
            matchCase: ctx.gscMatchCase,
          }),
        ),
      );
    case 'analytics':
      return asRecords(
        paged((limit, offset) => db.queryGa4({ limit, offset, accountId: ctx.ga4AccountId })),
      );
    case 'metrica':
      // queryMetrica caps a page at 1000 rows; a larger page would read as
      // the last one.
      return asRecords(
        paged(
          (limit, offset) => db.queryMetrica({ limit, offset, counterId: ctx.metricaCounterId }),
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
            db.queryAi({ limit, offset, provider: provider as 'openai' | 'anthropic' | 'ollama' }),
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
