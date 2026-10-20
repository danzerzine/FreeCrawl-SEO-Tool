/**
 * Named exports (`--what` tokens) and saved export sets. One place turns
 * the tokens into files, shared by `freecrawl export`, the CLI's post-crawl
 * `--export-dir`, and the desktop scheduler, so a saved set gives the same
 * files whichever of them runs it.
 */

import { join } from 'node:path';
import { EXPENSIVE_ISSUE_DEFINITIONS, type ProjectDb } from '@freecrawl/db';
import {
  EXPORT_DATASET_COLUMNS,
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
  | { kind: 'dataset'; name: string; dataset: ExportDatasetKey };

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
}

export const EXPORT_WHAT_HELP =
  'bulk, seo-audit, html, issues, tab:<key>, issues:<key>, dataset:<key>, ' +
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

export interface RunExportItemsOptions {
  /** Write the internal column keys instead of the grid labels. */
  rawHeaders?: boolean;
  /** Recorded in the bulk export's manifest. */
  projectFile?: string;
  toolVersion?: string;
  /** White-label header of the `html` report. */
  branding?: HtmlReportOptions['branding'];
  /** One line per step; the CLI sends it to stderr. */
  onProgress?: (line: string) => void;
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
  const headers = options.rawHeaders ? ('keys' as const) : undefined;
  const outcome: ExportOutcome = { files: [], errors: [] };
  const progress = options.onProgress ?? (() => {});
  // `issues:*` files read the materialised urls_issues table; a project
  // last materialised by an older set of checks would export stale lists.
  // A desktop-saved project is only changed in its working copy.
  if (db.issueMaterialisationStale()) {
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
          await runBulkExport(db, outDir, {
            headers,
            toolVersion: options.toolVersion,
            projectFile: options.projectFile,
          }),
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
        const { rowsWritten } = await exportIssuesSummary(db, path);
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
            for (const sk of skipped) {
              progress(`${sk.label}: ${sk.reason}`);
              outcome.errors.push({ label: sk.label, error: sk.reason });
            }
          } else {
            outcome.files.push({ path, label, rows: rowsWritten });
          }
        }
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
        const r = await exportLinkTargetReport(db, path, item.report);
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
        }
      }
    } catch (err) {
      outcome.errors.push({ label: item.name, error: (err as Error).message });
    }
  }
  return outcome;
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

/** Run a saved set into `outDir`: its tokens through {@link runExportItems}. */
export async function runExportSet(
  db: ProjectDb,
  outDir: string,
  set: ExportSet,
  options: RunExportItemsOptions = {},
): Promise<ExportOutcome> {
  return runExportItems(db, outDir, parseExportWhat(set.what.join(',')), {
    ...options,
    rawHeaders: options.rawHeaders || set.rawHeaders,
  });
}
