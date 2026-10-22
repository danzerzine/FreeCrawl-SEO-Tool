import { existsSync } from 'node:fs';
import { copyFile, rename, rm } from 'node:fs/promises';
import {
  compareCrawls,
  compareToFiles,
  compareWithoutMmap,
  openCompareProject,
  type CompareSummary,
} from '@freecrawl/core';
import type { ProjectDb } from '@freecrawl/db';

/**
 * `<dir>/<name>.previous.seoproject`: the copy of the saved project a
 * scheduled crawl compares the new crawl against (B81). One copy, replaced
 * on every scheduled run.
 */
export function previousCrawlPath(projectPath: string): string {
  return `${projectPath.replace(/\.seoproject$/i, '')}.previous.seoproject`;
}

/**
 * Copies the saved project over its previous copy, before the crawl's first
 * autosave can change the file. On failure the old copy is removed too, so
 * the report is skipped rather than run against an older crawl. Throws on
 * failure.
 */
export async function keepPreviousCrawl(projectPath: string): Promise<void> {
  const target = previousCrawlPath(projectPath);
  try {
    await copyFile(projectPath, `${target}.part`);
    await rename(`${target}.part`, target);
  } catch (err) {
    await rm(`${target}.part`, { force: true });
    await rm(target, { force: true });
    throw err;
  }
}

/**
 * Compares the previous copy ("before") with the project just crawled
 * ("after"), the same comparison as the Compare dialog. With `dir`, the
 * `compare-*.csv` files and `compare-summary.json` go there. Null when there
 * is no previous copy (the copy at the crawl's start failed). `workDir`: the
 * chosen working folder for the unpacked copy (B31).
 */
export async function runChangeReport(
  previousPath: string,
  db: ProjectDb,
  dir: string | null,
  workDir?: string,
): Promise<CompareSummary | null> {
  if (!existsSync(previousPath)) return null;
  const previous = await openCompareProject(previousPath, workDir);
  try {
    return await compareWithoutMmap(previous.db, db, () =>
      dir ? compareToFiles(previous.db, db, dir) : compareCrawls(previous.db, db),
    );
  } finally {
    previous.dispose();
  }
}
