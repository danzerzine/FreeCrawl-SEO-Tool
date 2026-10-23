/**
 * The export step of a scheduled crawl: writes what `afterCrawl.export`
 * names into `exportDir`. Kept out of `index.ts` (and free of Electron) so
 * it runs, and is tested, on its own; the PDF writer needs a window, so the
 * caller passes it in. Everything else goes through the same core function
 * as `freecrawl export --what` / `--set`, so a schedule and the CLI write
 * the same files.
 */

import { join } from 'node:path';
import type { ProjectDb } from '@freecrawl/db';
import {
  findExportSet,
  parseExportWhat,
  type ExportOutcome,
  type HtmlReportOptions,
  type RunExportItemsOptions,
} from '@freecrawl/core';
import type { ScheduleAfterCrawl } from '@freecrawl/shared-types';
import { runDesktopExportItems } from './export-sets.js';

export interface ScheduledExportContext {
  /** Existing folder the files go into. */
  exportDir: string;
  branding?: HtmlReportOptions['branding'];
  toolVersion: string;
  projectFile?: string;
  writePdf: (db: ProjectDb, target: string) => Promise<unknown>;
  onProgress?: (line: string) => void;
  /** B93: computes `dataset:link-suggestions` off the main thread (the desktop's worker). */
  linkSuggestionsRunner?: RunExportItemsOptions['linkSuggestionsRunner'];
}

export interface ScheduledExportResult {
  files: { path: string; rows: number | null }[];
  errors: string[];
}

export async function runScheduledExport(
  db: ProjectDb,
  after: ScheduleAfterCrawl,
  ctx: ScheduledExportContext,
): Promise<ScheduledExportResult> {
  const { exportDir } = ctx;
  if (after.export === 'none') return { files: [], errors: [] };
  if (after.export === 'pdf') {
    const target = join(exportDir, 'report.pdf');
    await ctx.writePdf(db, target);
    return { files: [{ path: target, rows: null }], errors: [] };
  }
  const options = {
    toolVersion: ctx.toolVersion,
    projectFile: ctx.projectFile,
    branding: ctx.branding,
    onProgress: ctx.onProgress,
    linkSuggestionsRunner: ctx.linkSuggestionsRunner,
  };
  let r: ExportOutcome;
  if (after.export === 'set') {
    let set;
    try {
      set = findExportSet(db, after.exportSet ?? '');
    } catch (err) {
      return { files: [], errors: [`export set: ${(err as Error).message}`] };
    }
    r = await runDesktopExportItems(db, exportDir, parseExportWhat(set.what.join(',')), {
      ...options,
      rawHeaders: set.rawHeaders,
    });
  } else {
    r = await runDesktopExportItems(db, exportDir, parseExportWhat(after.export), options);
  }
  return {
    files: r.files.map((f) => ({ path: f.path, rows: f.rows })),
    errors: r.errors.map((e) => `${e.label}: ${e.error}`),
  };
}

/** What the scheduled Sheets step needs from the Sheets export (injected: it needs Electron). */
export interface ScheduledSheetsDeps {
  exportToSheets: (
    db: ProjectDb,
    category: 'all',
    title: string,
  ) => Promise<{ spreadsheetUrl: string; rowsWritten: number; totalRows: number; truncated: boolean }>;
  log: (level: 'info' | 'warn', message: string) => void;
}

/**
 * The Google Sheets push of a scheduled crawl. Best-effort like the rest:
 * a failure, or a result cut at the 10 million cell limit, becomes an entry
 * of `errors` (which the webhook payload carries) and a log line.
 */
export async function runScheduledSheets(
  db: ProjectDb,
  title: string,
  deps: ScheduledSheetsDeps,
): Promise<{ sheetsUrl: string | null; errors: string[] }> {
  const errors: string[] = [];
  let sheetsUrl: string | null = null;
  try {
    const r = await deps.exportToSheets(db, 'all', title);
    sheetsUrl = r.spreadsheetUrl || null;
    deps.log('info', `Scheduled Sheets export: ${sheetsUrl} (${r.rowsWritten} rows)`);
    if (r.truncated) {
      const note = `exported ${r.rowsWritten} of ${r.totalRows} rows (Google Sheets holds at most 10 million cells)`;
      errors.push(`sheets: ${note}`);
      deps.log('warn', `Scheduled Sheets export: ${note}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`sheets: ${msg}`);
    deps.log('warn', `Scheduled Sheets export failed: ${msg}`);
  }
  return { sheetsUrl, errors };
}
