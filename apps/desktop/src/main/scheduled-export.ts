/**
 * The export step of a scheduled crawl: writes what `afterCrawl.export`
 * names into `exportDir`. Kept out of `index.ts` (and free of Electron) so
 * it runs, and is tested, on its own; the PDF writer needs a window, so the
 * caller passes it in. A saved export set goes through the same core
 * function as `freecrawl export --set`, so both write the same files.
 */

import { join } from 'node:path';
import type { ProjectDb } from '@freecrawl/db';
import {
  exportHtmlReport,
  findExportSet,
  runBulkExport,
  runExportSet,
  runSeoAuditExport,
  type HtmlReportOptions,
} from '@freecrawl/core';
import type { ScheduleAfterCrawl } from '@freecrawl/shared-types';

export interface ScheduledExportContext {
  /** Existing folder the files go into. */
  exportDir: string;
  startUrl: string;
  branding?: HtmlReportOptions['branding'];
  toolVersion: string;
  projectFile?: string;
  writePdf: (db: ProjectDb, target: string) => Promise<unknown>;
  onProgress?: (line: string) => void;
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
  const files: ScheduledExportResult['files'] = [];
  const errors: string[] = [];
  const add = (r: {
    files: { filePath: string; rowsWritten: number }[];
    errors: { label: string; error: string }[];
  }): void => {
    files.push(...r.files.map((f) => ({ path: f.filePath, rows: f.rowsWritten })));
    errors.push(...r.errors.map((e) => `${e.label}: ${e.error}`));
  };
  if (after.export === 'bulk') {
    add(await runBulkExport(db, exportDir, { toolVersion: ctx.toolVersion, projectFile: ctx.projectFile }));
  } else if (after.export === 'seo-audit') {
    add(await runSeoAuditExport(db, exportDir));
  } else if (after.export === 'html') {
    const target = join(exportDir, 'report.html');
    await exportHtmlReport(db, target, { startUrl: ctx.startUrl, branding: ctx.branding });
    files.push({ path: target, rows: null });
  } else if (after.export === 'pdf') {
    const target = join(exportDir, 'report.pdf');
    await ctx.writePdf(db, target);
    files.push({ path: target, rows: null });
  } else if (after.export === 'set') {
    let set;
    try {
      set = findExportSet(db, after.exportSet ?? '');
    } catch (err) {
      errors.push(`export set: ${(err as Error).message}`);
      return { files, errors };
    }
    const r = await runExportSet(db, exportDir, set, {
      toolVersion: ctx.toolVersion,
      projectFile: ctx.projectFile,
      branding: ctx.branding,
      onProgress: ctx.onProgress,
    });
    files.push(...r.files.map((f) => ({ path: f.path, rows: f.rows })));
    errors.push(...r.errors.map((e) => `${e.label}: ${e.error}`));
  }
  return { files, errors };
}
