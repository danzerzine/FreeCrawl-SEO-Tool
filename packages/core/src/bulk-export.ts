/**
 * Bulk export — writes one CSV per category/issue family into a target
 * folder. Shared by the desktop's File → Bulk Export (dialog-driven) and
 * the MCP `export_bulk` action (path-driven) so the long task list lives
 * in exactly one place.
 *
 * `import type` keeps `@freecrawl/db` a compile-time-only reference (core
 * must not take a runtime dependency on db) — same pattern as csv-export.
 */

import { join, relative, sep } from 'node:path';
import { readdir, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import type { ProjectDb } from '@freecrawl/db';
import { ISSUE_CATEGORIES } from '@freecrawl/shared-types';
import type {
  BulkExportFile,
  BulkExportResult,
  CrawlUrlRow,
  ExportDatasetKey,
  UrlCategory,
} from '@freecrawl/shared-types';
import { exportLinksToCsv, urlCsvFormat } from './csv-export.js';
import { writeUrlFilesInOnePass } from './url-files-pass.js';
import { exportDatasetFile } from './tabular-export.js';
import { writeExportFile } from './export-file.js';
import { m5ColumnsNotChecked, pageSignalsEmptyReason, pageSignalsWarnings } from './url-signals.js';

export interface BulkExportTask {
  label: string;
  file: string;
  category: UrlCategory;
  /** Column override for topic files whose whole point is a field the
   *  generic column set omits (extraction results, hreflang, security
   *  headers). When set these are appended to the base columns. */
  columns?: (keyof CrawlUrlRow)[];
}

/** Base columns every bulk file carries (mirrors csv-export's CSV_COLUMNS). */
const BULK_BASE_COLUMNS: (keyof CrawlUrlRow)[] = [
  'url',
  'statusCode',
  'contentKind',
  'indexability',
  'indexabilityReason',
  'title',
  'inlinks',
  'outlinks',
  'depth',
];

/** Every category/issue family the bulk dump emits, in display order. */
export const BULK_EXPORT_TASKS: BulkExportTask[] = [
  { label: 'All URLs', file: 'all-urls.csv', category: 'all' },
  { label: 'Internal HTML', file: 'internal-html.csv', category: 'internal:html' },
  { label: 'Internal All', file: 'internal-all.csv', category: 'internal:all' },
  { label: 'External All', file: 'external-all.csv', category: 'external:all' },
  { label: '2xx Success', file: 'status-2xx.csv', category: 'status:2xx' },
  { label: '3xx Redirects', file: 'status-3xx.csv', category: 'status:3xx' },
  { label: '4xx Client Errors', file: 'status-4xx.csv', category: 'status:4xx' },
  { label: '5xx Server Errors', file: 'status-5xx.csv', category: 'status:5xx' },
  { label: 'Indexable', file: 'indexable.csv', category: 'indexability:indexable' },
  { label: 'Non-Indexable', file: 'non-indexable.csv', category: 'indexability:non-indexable' },
  { label: 'Title Issues — Missing', file: 'issues-title-missing.csv', category: 'issues:title-missing' },
  { label: 'Title Issues — Duplicate', file: 'issues-title-duplicate.csv', category: 'issues:title-duplicate' },
  { label: 'Meta Description Issues — Missing', file: 'issues-meta-missing.csv', category: 'issues:meta-missing' },
  { label: 'H1 Issues — Missing', file: 'issues-h1-missing.csv', category: 'issues:h1-missing' },
  { label: 'Canonical Issues — Missing', file: 'issues-canonical-missing.csv', category: 'issues:canonical-missing' },
  { label: 'Pagination Broken', file: 'issues-pagination-broken.csv', category: 'issues:pagination-broken' },
  { label: 'Mixed Content', file: 'issues-mixed-content.csv', category: 'issues:mixed-content' },
  { label: 'Insecure Form Action', file: 'issues-insecure-form-action.csv', category: 'issues:insecure-form-action' },
  { label: 'Hreflang — Reciprocity Missing', file: 'hreflang-reciprocity-missing.csv', category: 'issues:hreflang-reciprocity-missing' },
  { label: 'Sitemap — Crawled, Not Listed', file: 'sitemap-crawled-not-in-sitemap.csv', category: 'issues:crawled-not-in-sitemap' },
  { label: 'Near-Duplicate Content', file: 'issues-near-duplicate.csv', category: 'issues:near-duplicate' },
  { label: 'All Redirects', file: 'all-redirects.csv', category: 'tab:redirects' },
  { label: 'Redirect Chains (Long)', file: 'redirect-chains-long.csv', category: 'issues:redirect-chain-long' },
  { label: 'Issues — Critical', file: 'issues-critical.csv', category: 'issues:severity-critical' },
  { label: 'Issues — Warning', file: 'issues-warning.csv', category: 'issues:severity-warning' },
  { label: 'Issues — Info', file: 'issues-info.csv', category: 'issues:severity-info' },
  { label: 'Orphan Pages', file: 'orphan-pages.csv', category: 'issues:orphan-page' },
  { label: 'Inlinks Nofollow Only', file: 'inlinks-nofollow-only.csv', category: 'issues:inlinks-nofollow-only' },
  { label: 'Inlinks Only From Non-Indexable Pages', file: 'inlinks-non-indexable-only.csv', category: 'issues:inlinks-non-indexable-only' },
  { label: 'Redirect Loops', file: 'redirect-loops.csv', category: 'issues:redirect-loop' },
  {
    label: 'Redirect & Canonical Chains',
    file: 'redirect-canonical-chains.csv',
    category: 'issues:redirect-canonical-chain',
    columns: ['redirectFinalUrl', 'redirectChainLength', 'canonicalFinalUrl', 'canonicalChainLength'],
  },
  { label: 'Self-Redirects', file: 'redirect-self.csv', category: 'issues:redirect-self' },
  { label: 'All Canonicals', file: 'all-canonicals.csv', category: 'tab:canonicals' },
  { label: 'Canonical — Non Self-Referencing', file: 'canonical-non-self.csv', category: 'issues:canonical-non-self' },
  { label: 'Canonical — To Non-200', file: 'canonical-to-non-200.csv', category: 'issues:canonical-to-non-200' },
  { label: 'Canonical — To Redirect', file: 'canonical-to-redirect.csv', category: 'issues:canonical-to-redirect' },
  { label: 'Canonical — To Noindex', file: 'canonical-to-noindex.csv', category: 'issues:canonical-to-noindex' },
  { label: 'Canonical — Multi-Hop Chain', file: 'canonical-chain-multi-hop.csv', category: 'issues:canonical-chain-multi-hop' },
  { label: 'Multiple Canonicals', file: 'canonical-multiple.csv', category: 'issues:multiple-canonicals' },
  { label: 'All Pagination', file: 'all-pagination.csv', category: 'tab:pagination' },
  { label: 'Pagination — Sequence Break', file: 'pagination-sequence-break.csv', category: 'issues:pagination-sequence-break' },
  { label: 'Pagination — Canonical Conflict', file: 'pagination-canonical-conflict.csv', category: 'issues:pagination-canonical-conflict' },
  {
    label: 'Hreflang — All',
    file: 'hreflang-all.csv',
    category: 'tab:hreflang',
    columns: [...BULK_BASE_COLUMNS, 'hreflangs'],
  },
  { label: 'Hreflang — x-default Missing', file: 'hreflang-x-default-missing.csv', category: 'issues:hreflang-x-default-missing' },
  { label: 'Hreflang — Invalid Language Code', file: 'hreflang-invalid-code.csv', category: 'issues:hreflang-invalid-code' },
  { label: 'Hreflang — Self-Ref Missing', file: 'hreflang-self-ref-missing.csv', category: 'issues:hreflang-self-ref-missing' },
  { label: 'Hreflang — Target Issues', file: 'hreflang-target-issues.csv', category: 'issues:hreflang-target-issues' },
  { label: 'Hreflang — Inconsistent Language', file: 'hreflang-inconsistent-lang.csv', category: 'issues:hreflang-inconsistent-lang' },
  { label: 'Hreflang — Unlinked Targets', file: 'hreflang-unlinked.csv', category: 'issues:hreflang-unlinked', columns: ['hreflangs'] },
  { label: 'Duplicate Pages', file: 'duplicate-pages.csv', category: 'tab:duplicates' },
  { label: 'Duplicate Content — Exact', file: 'duplicate-content-exact.csv', category: 'issues:duplicate-content-exact' },
  {
    label: 'Custom Extraction Results',
    file: 'custom-extraction.csv',
    category: 'tab:custom-extraction',
    columns: [...BULK_BASE_COLUMNS, 'extractionResults'],
  },
  {
    label: 'Custom Search Hits',
    file: 'custom-search.csv',
    category: 'tab:custom-search',
    columns: [...BULK_BASE_COLUMNS, 'customSearchHits'],
  },
  { label: 'Structured Data — Missing', file: 'structured-data-missing.csv', category: 'issues:structured-data-missing' },
  { label: 'Structured Data — Invalid', file: 'structured-data-invalid.csv', category: 'issues:structured-data-invalid' },
  { label: 'Structured Data — Duplicate @id', file: 'structured-data-duplicate-id.csv', category: 'issues:schema-duplicate-id' },
  { label: 'Structured Data — Missing Required Property', file: 'structured-data-missing-required.csv', category: 'issues:schema-missing-required', columns: ['schemaFindings'] },
  { label: 'Structured Data — Missing Recommended Property', file: 'structured-data-missing-recommended.csv', category: 'issues:schema-missing-recommended', columns: ['schemaFindings'] },
  { label: 'Structured Data — Malformed @type', file: 'structured-data-unknown-type.csv', category: 'issues:schema-unknown-type', columns: ['schemaFindings'] },
  { label: 'AMP Pages', file: 'amp-pages.csv', category: 'tab:amp' },
  { label: 'AMP — Validation Errors', file: 'amp-validation-errors.csv', category: 'issues:amp-validation-errors' },
  { label: 'Image — Missing Alt', file: 'image-missing-alt.csv', category: 'issues:image-missing-alt' },
  { label: 'Image — Empty Alt', file: 'image-empty-alt.csv', category: 'issues:image-empty-alt' },
  { label: 'Image — Duplicate Alt', file: 'image-duplicate-alt.csv', category: 'issues:image-duplicate-alt' },
  { label: 'Image — Too Large', file: 'image-too-large.csv', category: 'issues:image-too-large' },
  { label: 'Image — Broken Src', file: 'image-broken-src.csv', category: 'issues:image-broken-src' },
  {
    label: 'Security Audit',
    file: 'security-audit.csv',
    category: 'tab:security',
    columns: [
      ...BULK_BASE_COLUMNS,
      'hsts',
      'csp',
      'xFrameOptions',
      'xContentTypeOptions',
    ],
  },
  { label: 'Mixed Content — Active', file: 'mixed-content-active.csv', category: 'issues:mixed-content-active' },
  { label: 'Mixed Content — Passive', file: 'mixed-content-passive.csv', category: 'issues:mixed-content-passive' },
  { label: 'HSTS Missing', file: 'security-hsts-missing.csv', category: 'issues:hsts-missing' },
  { label: 'CSP Missing', file: 'security-csp-missing.csv', category: 'issues:csp-missing' },
  { label: 'SERP Summary', file: 'serp-summary.csv', category: 'tab:serp' },
  { label: 'Outlinks Zero', file: 'outlinks-zero.csv', category: 'issues:outlinks-zero' },
  // B45: written only by a crawl that ran with the markup check (no rows, no file, otherwise).
  {
    label: 'HTML Markup Errors',
    file: 'issues-markup-errors.csv',
    category: 'issues:markup-errors',
    columns: [...BULK_BASE_COLUMNS, 'markupErrors', 'markupCodes'],
  },
  {
    label: 'Duplicate id Attributes',
    file: 'issues-duplicate-ids.csv',
    category: 'issues:duplicate-ids',
    columns: [...BULK_BASE_COLUMNS, 'markupErrors', 'markupCodes'],
  },
  // B44b: written only by a crawl that rendered with the coverage option.
  {
    label: 'Unused CSS',
    file: 'issues-css-unused.csv',
    category: 'issues:css-unused',
    columns: [...BULK_BASE_COLUMNS, 'cssBytes', 'cssUnusedBytes'],
  },
  {
    label: 'Unused JavaScript',
    file: 'issues-js-unused.csv',
    category: 'issues:js-unused',
    columns: [...BULK_BASE_COLUMNS, 'jsBytes', 'jsUnusedBytes'],
  },
];

export interface BulkExportDatasetTask {
  label: string;
  file: string;
  dataset: ExportDatasetKey;
}

/** Link, issue, sitemap and queue tables that are not views over the URL rows. */
export const BULK_EXPORT_DATASET_TASKS: BulkExportDatasetTask[] = [
  { label: 'Broken Links', file: 'broken-links.csv', dataset: 'broken-links' },
  { label: 'Broken Links — By Target', file: 'broken-links-by-target.csv', dataset: 'broken-links-by-target' },
  { label: 'Issues — One Row Per URL and Issue', file: 'issues-long.csv', dataset: 'issues-long' },
  { label: 'Page Signals — One Row Per URL and Signal', file: 'page-signals.csv', dataset: 'page-signals' },
  { label: 'Response Headers — One Row Per URL and Header', file: 'response-headers.csv', dataset: 'response-headers' },
  { label: 'Sitemap URLs', file: 'sitemap-urls.csv', dataset: 'sitemap-urls' },
  { label: 'Sitemap Files', file: 'sitemap-files.csv', dataset: 'sitemap-files' },
  { label: 'Sitemap vs Crawl', file: 'sitemap-reconciliation.csv', dataset: 'sitemap-reconciliation' },
  { label: 'Crawl Queue (Unfetched)', file: 'crawl-queue.csv', dataset: 'crawl-queue' },
];

const NO_SITEMAP_REASON =
  'No sitemap URLs are stored in this project (no sitemap was read, or the ones read held no URLs), so no file written.';

/**
 * Subfolder of the per-issue inlinks files (`inlinks-<issue>.csv`). One
 * file per issue would add ~70 files beside the ~80 category files, and
 * `inlinks-*` names already belong to two of those (Inlinks Nofollow
 * Only, Inlinks Only From Non-Indexable Pages); the folder keeps them
 * apart, like Screaming Frog's Bulk Export → Issues folder.
 */
export const ISSUE_INLINKS_SUBDIR = 'issue-inlinks';

/**
 * Per-issue inlinks: every link into the pages that have the issue, one
 * file per enabled issue with pages, under `<outputDir>/issue-inlinks/`.
 * Not part of the bulk dump: on a large site it runs to tens of GB (every
 * link into every flagged page, per check). Written on request only, by the
 * CLI's `--what dataset:issue-inlinks` (every check) or `issue-inlinks:<check>`.
 */
/** `inlinks-<check>.csv`: the name keeps to `[a-z0-9-]`. */
function issueInlinksFileName(key: string): string {
  return `inlinks-${key.replace(/^issues:/, '').replace(/[^a-z0-9-]/gi, '-')}.csv`;
}

export async function exportIssueInlinks(
  db: ProjectDb,
  outputDir: string,
  options: {
    headers?: 'labels' | 'keys';
    /** Only these checks (catalogue keys); other checks' files in the folder stay. */
    issueKeys?: readonly string[];
  } = {},
): Promise<{ files: BulkExportFile[]; errors: { label: string; error: string }[] }> {
  const files: BulkExportFile[] = [];
  const errors: { label: string; error: string }[] = [];
  const disabled = db.getDisabledIssues();
  const chosen = options.issueKeys;
  // Every enabled check of the catalogue, not only the expensive ones
  // materialised into `urls_issues`; a check with no pages leaves no file.
  // Keys never come from the project file, and the name keeps to
  // `[a-z0-9-]`, so no key can name a path outside the subfolder.
  const issueKeys = ISSUE_CATEGORIES.filter(
    (key) => !disabled.has(key) && (chosen === undefined || chosen.includes(key)),
  ).sort();
  const ownNames = new Set(issueKeys.map(issueInlinksFileName));
  const issueDir = join(outputDir, ISSUE_INLINKS_SUBDIR);
  const writtenNames = new Set<string>();
  for (const key of issueKeys) {
    const fileName = issueInlinksFileName(key);
    const issueLabel =
      BULK_EXPORT_TASKS.find((t) => t.category === key)?.label ?? key.replace(/^issues:/, '');
    const label = `Issue Inlinks — ${issueLabel}`;
    const filePath = join(issueDir, fileName);
    try {
      const { rowsWritten } = await exportDatasetFile(db, filePath, 'issue-inlinks', {
        label,
        headers: options.headers,
        datasetContext: { issueKey: key },
      });
      if (rowsWritten === 0) continue;
      writtenNames.add(fileName);
      files.push({ filePath, label, dataset: 'issue-inlinks', rowsWritten });
    } catch (err) {
      // A failed write keeps the check's previous file (writeExportFile
      // leaves it untouched); the cleanup below must not delete it either.
      writtenNames.add(fileName);
      errors.push({ label, error: (err as Error).message });
    }
  }
  // A rerun into the same folder: an issue fixed since the last run must
  // not leave its old inlinks file behind as if it still had pages. Only
  // the files of the checks this run covered go (all of them, or the chosen
  // ones); anything else in the folder stays.
  const previous = await readdir(issueDir).catch(() => [] as string[]);
  for (const entry of previous) {
    const covered = chosen === undefined ? /^inlinks-.*\.csv$/.test(entry) : ownNames.has(entry);
    if (covered && !writtenNames.has(entry)) {
      await unlink(join(issueDir, entry)).catch(() => undefined);
    }
  }
  await rmdir(issueDir).catch(() => undefined); // only when empty
  return { files, errors };
}

/** Whole ms since `t0` (a `performance.now()` reading). */
export function since(t0: number): number {
  return Math.round(performance.now() - t0);
}

/**
 * The process's peak memory so far, MB (`maxRSS`; on Windows the peak
 * working set). Read when a file is done, it is the high-water mark up to
 * that file, not the file's own share.
 */
export function peakRssMb(): number {
  return Math.round(process.resourceUsage().maxRSS / 1024);
}

/**
 * Write every {@link BULK_EXPORT_TASKS} category to a CSV under
 * `outputDir` (created when missing). Each file goes through
 * `<name>.part` + rename; zero-row categories leave no file, so the dump
 * folder isn't littered with empty files. Per-task write failures are
 * collected (never abort the whole run). Caller owns any UI / dialogs.
 * `tasks` narrows the run to those categories only (the CLI's
 * `tab:<key>`): no link or dataset files then.
 */
export async function runBulkExport(
  db: ProjectDb,
  outputDir: string,
  options: BulkExportOptions = {},
): Promise<BulkExportResult> {
  // Reads through SQLite's page cache: see `withoutMmap`.
  return db.withoutMmap(() => writeBulkExport(db, outputDir, options));
}

interface BulkExportOptions {
  tasks?: readonly BulkExportTask[];
  /** Header row of the CSV files: the grid's labels (default) or raw keys. */
  headers?: 'labels' | 'keys';
  /** Tool version and project file, recorded in `manifest.json`. */
  toolVersion?: string;
  projectFile?: string;
  /**
   * `false`: no `manifest.json` of its own; a caller running several
   * exports into the folder writes one for the whole run.
   */
  manifest?: boolean;
}

async function writeBulkExport(
  db: ProjectDb,
  outputDir: string,
  options: BulkExportOptions,
): Promise<BulkExportResult> {
  const startedAt = new Date();
  const writesManifest = !options.tasks && options.manifest !== false;
  // A manifest means the run reached the end: a previous run's one must
  // not stand beside files this run is replacing one by one.
  if (writesManifest) await rm(join(outputDir, 'manifest.json'), { force: true });
  const files: BulkExportFile[] = [];
  const errors: { label: string; error: string }[] = [];
  const hasRows = (r: { rowsWritten: number }): boolean => r.rowsWritten > 0;
  // Silenced checks (Settings → Issues) get no file at all — an empty CSV
  // for a check the user turned off would read as "nothing found".
  const disabled = db.getDisabledIssues();
  // Every category file in one pass over the urls table.
  const tasks = (options.tasks ?? BULK_EXPORT_TASKS).filter((t) => !disabled.has(t.category));
  const t0 = performance.now();
  // Once for the whole pass, never per row: the signal columns whose check the project never filled.
  const notChecked = m5ColumnsNotChecked(db);
  const settled = await writeUrlFilesInOnePass(
    db,
    tasks.map((task) => ({
      filePath: join(outputDir, task.file),
      category: task.category,
      ...urlCsvFormat({ columns: task.columns, headers: options.headers, notChecked }),
      keep: (rows: number) => rows > 0,
    })),
  );
  const passMs = since(t0);
  const passPeakMb = peakRssMb();
  settled.forEach((r, i) => {
    const task = tasks[i]!;
    if (r.status === 'rejected') {
      const err = r.reason;
      errors.push({ label: task.label, error: err instanceof Error ? err.message : String(err) });
    } else if (r.value > 0) {
      files.push({
        filePath: join(outputDir, task.file),
        label: task.label,
        category: task.category,
        rowsWritten: r.value,
        // Files of one pass finish together: each took the pass's time.
        ms: passMs,
        peakRssMb: passPeakMb,
        sharedPass: true,
      });
    }
  });
  if (options.tasks) return { outputDir, files, errors };
  // Link-level files: one row per edge rather than per page.
  for (const scope of ['internal', 'external'] as const) {
    const label = scope === 'internal' ? 'Links — Internal' : 'Links — External';
    const filePath = join(outputDir, `links-${scope}.csv`);
    const t0 = performance.now();
    try {
      const { rowsWritten } = await writeExportFile(
        filePath,
        (partPath) => exportLinksToCsv(db, partPath, { scope, headers: options.headers }),
        hasRows,
      );
      if (rowsWritten === 0) continue;
      files.push({
        filePath,
        label,
        category: scope === 'internal' ? 'internal:all' : 'external:all',
        rowsWritten,
        ms: since(t0),
        peakRssMb: peakRssMb(),
      });
    } catch (err) {
      errors.push({ label, error: (err as Error).message });
    }
  }
  const skipped: { label: string; reason: string }[] = [];
  for (const task of BULK_EXPORT_DATASET_TASKS) {
    const filePath = join(outputDir, task.file);
    const t0 = performance.now();
    try {
      const { rowsWritten, skipped: why } = await exportDatasetFile(db, filePath, task.dataset, {
        label: task.label,
        headers: options.headers,
      });
      if (rowsWritten === 0) {
        // Empty because the crawl stored nothing it could have: say why.
        if (why) skipped.push(...why);
        else if (task.dataset === 'sitemap-urls' || task.dataset === 'sitemap-files') {
          skipped.push({ label: task.label, reason: NO_SITEMAP_REASON });
        } else if (task.dataset === 'page-signals') {
          skipped.push({ label: task.label, reason: pageSignalsEmptyReason(db) });
        }
        continue;
      }
      const warnings = task.dataset === 'page-signals' ? pageSignalsWarnings(db) : [];
      files.push({
        filePath,
        label: task.label,
        dataset: task.dataset,
        rowsWritten,
        ms: since(t0),
        peakRssMb: peakRssMb(),
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    } catch (err) {
      errors.push({ label: task.label, error: (err as Error).message });
    }
  }
  const result: BulkExportResult = { outputDir, files, errors, skipped };
  if (writesManifest) await writeBulkManifest(result, startedAt, options);
  return result;
}

/**
 * `manifest.json` beside the files: what was written (relative path, label,
 * rows), when, by which tool version, from which project. Written last, so
 * its presence means the run reached the end. A failed manifest is an
 * error entry like any other file, not an abort.
 */
async function writeBulkManifest(
  result: BulkExportResult,
  startedAt: Date,
  options: { toolVersion?: string; projectFile?: string },
): Promise<void> {
  try {
    const manifest = {
      tool: 'FreeCrawl SEO Tool',
      toolVersion: options.toolVersion ?? null,
      projectFile: options.projectFile ?? null,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      files: result.files.map((f) => ({
        path: relative(result.outputDir, f.filePath).split(sep).join('/'),
        label: f.label,
        rows: f.rowsWritten,
        ms: f.ms,
        peakRssMb: f.peakRssMb,
        sharedPass: f.sharedPass,
        warnings: f.warnings,
      })),
      errors: result.errors,
      skipped: result.skipped ?? [],
    };
    await writeExportFile(join(result.outputDir, 'manifest.json'), (partPath) =>
      writeFile(partPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
    );
  } catch (err) {
    result.errors.push({ label: 'Manifest', error: (err as Error).message });
  }
}
