/**
 * Saved export sets and the selected-URL links export, as the desktop
 * runs them. Kept out of `index.ts` (and free of Electron) so it runs, and
 * is tested, on its own; the folder pickers and result boxes stay in the
 * IPC / menu handlers. Everything goes through the same core functions as
 * `freecrawl export --set` / `--urls`, so the app and the CLI write the
 * same files.
 */

import type { ProjectDb } from '@freecrawl/db';
import {
  BULK_EXPORT_TASKS,
  CLI_EXPORT_DATASETS,
  LINK_TARGET_EXPORTS,
  findExportSet,
  runExportItems,
  runExportSet,
  type ExportOutcome,
  type RunExportItemsOptions,
} from '@freecrawl/core';
import { ISSUE_CATEGORIES, type ExportSetChoiceGroup } from '@freecrawl/shared-types';

/**
 * Every `--what` token a set can hold, grouped for the picker. Tab and
 * issue tokens carry the bulk-export file label (English; the renderer
 * translates it like the Export As tree does).
 */
export function exportSetChoices(): ExportSetChoiceGroup[] {
  const labels = new Map<string, string[]>();
  for (const t of BULK_EXPORT_TASKS) {
    if (!t.category.startsWith('tab:') && !t.category.startsWith('issues:')) continue;
    labels.set(t.category, [...(labels.get(t.category) ?? []), t.label]);
  }
  const byPrefix = (prefix: string) =>
    [...labels].filter(([c]) => c.startsWith(prefix)).map(([token, l]) => ({ token, label: l.join(', ') }));
  return [
    { group: 'exports', choices: ['bulk', 'seo-audit', 'html', 'issues'].map((token) => ({ token })) },
    { group: 'links', choices: LINK_TARGET_EXPORTS.map((r) => ({ token: r.report, label: r.label })) },
    { group: 'tabs', choices: byPrefix('tab:') },
    { group: 'issues', choices: byPrefix('issues:') },
    { group: 'datasets', choices: CLI_EXPORT_DATASETS.map((k) => ({ token: `dataset:${k}` })) },
    {
      group: 'issueInlinks',
      choices: ISSUE_CATEGORIES.map((c) => ({
        token: `issue-inlinks:${c.slice('issues:'.length)}`,
        label: labels.get(c)?.join(', '),
      })),
    },
  ];
}

/** Run the saved set called `name` into `outDir`; throws before writing when there is none. */
export async function runSavedExportSet(
  db: ProjectDb,
  outDir: string,
  name: string,
  options: RunExportItemsOptions,
): Promise<ExportOutcome> {
  return runExportSet(db, outDir, findExportSet(db, name), options);
}

/** `selected-inlinks.csv` and `selected-outlinks.csv` for the chosen pages (CLI `--urls`). */
export async function exportSelectedLinks(
  db: ProjectDb,
  outDir: string,
  urls: string[],
  options: RunExportItemsOptions,
): Promise<ExportOutcome> {
  return runExportItems(db, outDir, [{ kind: 'selected', name: 'selected-links', urls }], options);
}
