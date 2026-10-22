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
