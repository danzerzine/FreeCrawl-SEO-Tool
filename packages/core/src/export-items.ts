/**
 * Named exports (`--what` tokens) and saved export sets. One place turns
 * the tokens into files, shared by `freecrawl export`, the CLI's post-crawl
 * `--export-dir`, and the desktop scheduler, so a saved set gives the same
 * files whichever of them runs it.
 */

import { rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { EXPENSIVE_ISSUE_DEFINITIONS, type ProjectDb } from '@freecrawl/db';
import {
  EXPORT_DATASET_COLUMNS,
  ISSUE_CATEGORIES,
  type BulkExportResult,
  type ExportDatasetKey,
  type ExportSet,
  type LinkTargetReportKind,
} from '@freecrawl/shared-types';
import { BULK_EXPORT_TASKS, exportIssueInlinks, runBulkExport, type BulkExportTask } from './bulk-export.js';
import { writeExportFile } from './export-file.js';
import { exportHtmlReport, type HtmlReportOptions } from './html-report.js';
import { exportIssuesSummary, exportLinkTargetReport, LINK_TARGET_EXPORTS } from './report-export.js';
import { runSeoAuditExport } from './seo-audit-export.js';
import { exportTabular } from './tabular-export.js';

/** One `--what` entry of `freecrawl export`. */
export type ExportItem =
  | { kind: 'bulk' | 'seo-audit' | 'html' | 'issues'; name: string }
  | { kind: 'category'; name: string; tasks: BulkExportTask[] }
  | { kind: 'link'; name: string; report: LinkTargetReportKind; label: string }
  | { kind: 'selected'; name: 'selected-links'; urls: string[] }
  | { kind: 'dataset'; name: string; dataset: ExportDatasetKey }
  | { kind: 'issue-inlinks'; name: string; issueKeys: string[] };

/** Datasets pulled from a linked Google / Yandex account, which the CLI has none of. */
const ACCOUNT_DATASETS: readonly ExportDatasetKey[] = ['search-console', 'analytics', 'metrica'];

/**
 * Datasets `--what dataset:<key>` can write. Left out: the `selected-*`
 * ones (they need chosen pages: `--urls`) and the Search Console,
 * Analytics and Metrica pulls (they need a linked account).
 */
export const CLI_EXPORT_DATASETS = (Object.keys(EXPORT_DATASET_COLUMNS) as ExportDatasetKey[]).filter(
  (k) => !k.startsWith('selected-') && !ACCOUNT_DATASETS.includes(k),
);

/** Page bodies exceed the 32,767-character cell limit of CSV / Excel: JSON Lines only. */
const JSONL_DATASETS: readonly ExportDatasetKey[] = ['page-html', 'page-text'];

export interface ExportOutcome {
  files: { path: string; label: string; rows: number | null }[];
  errors: { label: string; error: string }[];
  /** Outputs that held no rows, so no file was written; not a failure. */
  skipped: { label: string; reason: string }[];
}

export const EXPORT_WHAT_HELP =
  'bulk, seo-audit, html, issues, tab:<key>, issues:<key>, dataset:<key>, issue-inlinks:<check>, ' +
  LINK_TARGET_EXPORTS.map((r) => r.report).join(', ');

/**
 * Parse a `--what` list (default `bulk`). Category keys are the bulk-export
 * task categories (`tab:redirects`, `issues:title-missing`); a bad entry
 * throws a message that lists the valid ones.
 */
export function parseExportWhat(what: string | undefined): ExportItem[] {
  const names = [...new Set((what ?? 'bulk').split(',').map((s) => s.trim()).filter(Boolean))];
  if (names.length === 0) throw new Error(`--what is empty (expected: ${EXPORT_WHAT_HELP}).`);
  return names.map((name): ExportItem => {
    if (name === 'bulk' || name === 'seo-audit' || name === 'html' || name === 'issues') {
      return { kind: name, name };
    }
    const link = LINK_TARGET_EXPORTS.find((r) => r.report === name);
    if (link) return { kind: 'link', name, report: link.report, label: link.label };
    if (name.startsWith('issue-inlinks:')) {
      const key = `issues:${name.slice('issue-inlinks:'.length)}`;
      if ((ISSUE_CATEGORIES as readonly string[]).includes(key)) {
        return { kind: 'issue-inlinks', name, issueKeys: [key] };
      }
      throw new Error(
        `Unknown check in --what: ${name}. Use the key after "issues:", e.g. issue-inlinks:h1-missing.`,
      );
    }
    if (name.startsWith('dataset:')) {
      const key = name.slice('dataset:'.length) as ExportDatasetKey;
      if (CLI_EXPORT_DATASETS.includes(key)) return { kind: 'dataset', name, dataset: key };
      const hint = key.startsWith('selected-')
        ? ' (it needs chosen pages: use --urls <file> instead)'
        : ACCOUNT_DATASETS.includes(key)
          ? ' (it needs a linked account, which the CLI does not have)'
          : '';
      throw new Error(
        `Unknown dataset in --what: ${name}${hint}. Valid keys: ${CLI_EXPORT_DATASETS.join(', ')}`,
      );
    }
    if (name.startsWith('tab:') || name.startsWith('issues:')) {
      const tasks = BULK_EXPORT_TASKS.filter((t) => t.category === name);
      if (tasks.length > 0) return { kind: 'category', name, tasks };
      const valid = [
        ...new Set(
          BULK_EXPORT_TASKS.map((t) => t.category).filter(
            (c) => c.startsWith('tab:') || c.startsWith('issues:'),
          ),
        ),
      ];
      throw new Error(`Unknown category in --what: ${name}. Valid keys: ${valid.join(', ')}`);
    }
    throw new Error(`Unknown --what entry: ${name} (expected: ${EXPORT_WHAT_HELP}).`);
  });
}

/** Whether `item` reads the materialised issue lists (`urls_issues`). */
function readsIssueData(item: ExportItem): boolean {
  switch (item.kind) {
    case 'bulk':
    case 'seo-audit':
    case 'html': // the overview counts
    case 'issues':
      return true;
    case 'category':
      return item.tasks.some((t) => t.category.startsWith('issues:'));
    case 'dataset':
      return item.dataset === 'issues-long' || item.dataset === 'issue-inlinks';
    case 'issue-inlinks':
      return true;
    case 'link':
    case 'selected':
      return false;
  }
}

export interface RunExportItemsOptions {
  /** Write the internal column keys instead of the grid labels. */
  rawHeaders?: boolean;
  /** Recorded in the run's manifest.json. */
  projectFile?: string;
  toolVersion?: string;
  /** White-label header of the `html` report. */
  branding?: HtmlReportOptions['branding'];
  /** One line per step; the CLI sends it to stderr. */
  onProgress?: (line: string) => void;
  /**
   * Filled as items finish (and returned), so a caller cut short by
   * Ctrl-C can still report the files written so far.
   */
  outcome?: ExportOutcome;
}

/**
 * Write each requested export into `outDir`. Failures are collected per
 * export, never abort the others.
 */
export async function runExportItems(
  db: ProjectDb,
  outDir: string,
  items: readonly ExportItem[],
  options: RunExportItemsOptions = {},
): Promise<ExportOutcome> {
  const startedAt = new Date();
  const headers = options.rawHeaders ? ('keys' as const) : undefined;
  const outcome: ExportOutcome = options.outcome ?? { files: [], errors: [], skipped: [] };
  const progress = options.onProgress ?? (() => {});
  // Its presence means the run reached the end: a previous run's manifest
  // goes before any file of this run replaces one of its files.
  await rm(join(outDir, 'manifest.json'), { force: true });
  // Issue lists and counts read the materialised urls_issues table; a
  // project last materialised by an older set of checks would export stale
  // ones. They are refilled only when this run reads them. It is derived
  // data, written the same way a crawl writes it: a bare project file is
  // refreshed in place, a desktop-saved one only in its working copy.
  if (items.some(readsIssueData) && db.issueMaterialisationStale()) {
    progress('Issue lists predate the current checks: recomputing them…');
    try {
      db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    } catch (err) {
      outcome.errors.push({ label: 'Issue lists recompute', error: (err as Error).message });
    }
  }
  const addBulk = (r: Pick<BulkExportResult, 'files' | 'errors'>): void => {
    outcome.files.push(...r.files.map((f) => ({ path: f.filePath, label: f.label, rows: f.rowsWritten })));
    outcome.errors.push(...r.errors);
  };
  for (const item of items) {
    progress(`Exporting ${item.name}…`);
    try {
      if (item.kind === 'bulk') {
        addBulk(
          // The run's own manifest, written last, covers the bulk files.
          await runBulkExport(db, outDir, { headers, manifest: false }),
        );
      } else if (item.kind === 'category') {
        addBulk(await runBulkExport(db, outDir, { tasks: item.tasks, headers }));
      } else if (item.kind === 'seo-audit') {
        addBulk(await runSeoAuditExport(db, join(outDir, 'seo-audit')));
      } else if (item.kind === 'html') {
        const path = join(outDir, 'report.html');
        await exportHtmlReport(db, path, {
          startUrl: db.getMeta('lastStartUrl') ?? '',
          ...(options.branding ? { branding: options.branding } : {}),
        });
        outcome.files.push({ path, label: 'HTML Report', rows: null });
      } else if (item.kind === 'issues') {
        const path = join(outDir, 'issues-summary.csv');
        const { rowsWritten } = await exportIssuesSummary(db, path, { headers });
        outcome.files.push({ path, label: 'Issues Summary', rows: rowsWritten });
      } else if (item.kind === 'dataset') {
        if (item.dataset === 'issue-inlinks') {
          // Every issue, one file each in the issue-inlinks/ subfolder.
          addBulk(await exportIssueInlinks(db, outDir, { headers }));
        } else {
          const label = item.name;
          const jsonl = JSONL_DATASETS.includes(item.dataset);
          const path = join(outDir, `${item.dataset.replace(':', '-')}.${jsonl ? 'jsonl' : 'csv'}`);
          const { rowsWritten, skipped } = await writeExportFile(
            path,
            (partPath) =>
              exportTabular(db, partPath, {
                format: jsonl ? 'jsonl' : 'csv',
                sections: [{ label, dataset: item.dataset }],
                columns: EXPORT_DATASET_COLUMNS[item.dataset].map((c) => c.key),
                headers,
              }),
            (r) => r.rowsWritten > 0,
          );
          if (skipped) {
            // Nothing stored that the crawl could have stored (page bodies
            // off): a failure of the run, with the reason.
            for (const sk of skipped) {
              progress(`${sk.label}: ${sk.reason}`);
              outcome.errors.push({ label: sk.label, error: sk.reason });
            }
          } else if (rowsWritten === 0) {
            outcome.skipped.push({ label, reason: 'No rows in this crawl: no file written.' });
          } else {
            outcome.files.push({ path, label, rows: rowsWritten });
          }
        }
      } else if (item.kind === 'issue-inlinks') {
        addBulk(await exportIssueInlinks(db, outDir, { headers, issueKeys: item.issueKeys }));
      } else if (item.kind === 'selected') {
        for (const dataset of ['selected-inlinks', 'selected-outlinks'] as const) {
          const label = dataset === 'selected-inlinks' ? 'Selected Inlinks' : 'Selected Outlinks';
          const path = join(outDir, `${dataset}.csv`);
          const { rowsWritten } = await writeExportFile(path, (partPath) =>
            exportTabular(db, partPath, {
              format: 'csv',
              sections: [{ label, dataset }],
              columns: EXPORT_DATASET_COLUMNS[dataset].map((c) => c.key),
              datasetContext: { urls: item.urls },
              headers,
            }),
          );
          outcome.files.push({ path, label, rows: rowsWritten });
        }
      } else if (item.kind === 'link') {
        const path = join(outDir, `${item.report}.csv`);
        const r = await exportLinkTargetReport(db, path, item.report, { headers });
        if (r === null) {
          outcome.errors.push({
            label: item.label,
            error:
              'Not computed: redirect chains have not been computed for this crawl, so redirect ' +
              'targets have no final target yet. They are computed at the end of a crawl with ' +
              'redirect-chain analysis on. No file written.',
          });
        } else if (r.rowsWritten > 0) {
          outcome.files.push({ path, label: item.label, rows: r.rowsWritten });
        } else {
          outcome.skipped.push({
            label: item.label,
            reason: 'No link targets of this kind in this crawl: no file written.',
          });
        }
      }
    } catch (err) {
      outcome.errors.push({ label: item.name, error: (err as Error).message });
    }
  }
  await writeRunManifest(outDir, items, outcome, startedAt, options);
  return outcome;
}

/**
 * `manifest.json` in `outDir`: every file this run wrote (relative path,
 * label, rows), what was asked, when, by which tool version, from which
 * project. Written last, so its presence means the run reached the end;
 * it replaces the manifest a `bulk` item wrote for its own files. A
 * failed manifest is an error entry, not an abort.
 */
async function writeRunManifest(
  outDir: string,
  items: readonly ExportItem[],
  outcome: ExportOutcome,
  startedAt: Date,
  options: RunExportItemsOptions,
): Promise<void> {
  try {
    const manifest = {
      tool: 'FreeCrawl SEO Tool',
      toolVersion: options.toolVersion ?? null,
      projectFile: options.projectFile ?? null,
      what: items.map((i) => i.name),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      files: outcome.files.map((f) => ({
        path: relative(outDir, f.path).split(sep).join('/'),
        label: f.label,
        rows: f.rows,
      })),
      errors: outcome.errors,
      skipped: outcome.skipped,
    };
    await writeExportFile(join(outDir, 'manifest.json'), (partPath) =>
      writeFile(partPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
    );
  } catch (err) {
    outcome.errors.push({ label: 'Manifest', error: (err as Error).message });
  }
}

/** `project_meta` key: JSON array of {@link ExportSet}. */
const EXPORT_SETS_META_KEY = 'exportSets';

/** The project's saved export sets, in the order they were first saved. */
export function listExportSets(db: ProjectDb): ExportSet[] {
  let raw: unknown;
  try {
    raw = JSON.parse(db.getMeta(EXPORT_SETS_META_KEY) || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s): ExportSet[] => {
    if (typeof s?.name !== 'string' || !Array.isArray(s.what)) return [];
    const what = (s.what as unknown[]).filter((w): w is string => typeof w === 'string');
    return [{ name: s.name, what, ...(s.rawHeaders === true ? { rawHeaders: true } : {}) }];
  });
}

/**
 * Save (or replace, by name) an export set. The tokens are checked the way
 * `--what` is, so a bad entry throws and nothing is saved; they are stored
 * trimmed and de-duplicated.
 */
export function saveExportSet(db: ProjectDb, set: ExportSet): ExportSet {
  const name = set.name.trim();
  if (name === '') throw new Error('An export set needs a name.');
  const what = parseExportWhat(set.what.join(',')).map((i) => i.name);
  const saved: ExportSet = { name, what, ...(set.rawHeaders ? { rawHeaders: true } : {}) };
  const sets = listExportSets(db);
  const at = sets.findIndex((s) => s.name === name);
  if (at >= 0) sets[at] = saved;
  else sets.push(saved);
  db.setMeta(EXPORT_SETS_META_KEY, JSON.stringify(sets));
  return saved;
}

/** Delete the saved set called `name`; false when there was none. */
export function deleteExportSet(db: ProjectDb, name: string): boolean {
  const sets = listExportSets(db);
  const kept = sets.filter((s) => s.name !== name.trim());
  if (kept.length === sets.length) return false;
  db.setMeta(EXPORT_SETS_META_KEY, JSON.stringify(kept));
  return true;
}

/** The saved set called `name`; throws, naming the saved ones, when there is none. */
export function findExportSet(db: ProjectDb, name: string): ExportSet {
  const sets = listExportSets(db);
  const set = sets.find((s) => s.name === name.trim());
  if (set) return set;
  throw new Error(
    `No export set named "${name}" in this project` +
      (sets.length > 0 ? ` (saved: ${sets.map((s) => s.name).join(', ')}).` : ' (none saved yet).'),
  );
}

/**
 * Run a saved set into `outDir`: its tokens through {@link runExportItems},
 * then `extraItems` (the CLI's `--urls`). Throws before writing anything
 * when a stored token is no longer valid.
 */
export async function runExportSet(
  db: ProjectDb,
  outDir: string,
  set: ExportSet,
  options: RunExportItemsOptions & { extraItems?: readonly ExportItem[] } = {},
): Promise<ExportOutcome> {
  const { extraItems = [], ...rest } = options;
  return runExportItems(db, outDir, [...parseExportWhat(set.what.join(',')), ...extraItems], {
    ...rest,
    rawHeaders: rest.rawHeaders || set.rawHeaders,
  });
}
