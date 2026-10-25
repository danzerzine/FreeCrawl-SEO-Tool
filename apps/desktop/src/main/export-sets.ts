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
  PDF_MAX_RUN_BYTES,
  findExportSet,
  listExportSets,
  parseExportWhat,
  runExportItems,
  saveExportSet,
  type ExportItem,
  type ExportOutcome,
  type RunExportItemsOptions,
} from '@freecrawl/core';
import {
  ISSUE_CATEGORIES,
  type CrawlConfig,
  type ExportSet,
  type ExportSetChoiceGroup,
} from '@freecrawl/shared-types';

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
    {
      group: 'exports',
      choices: ['bulk', 'seo-audit', 'html', 'audit', 'issues', 'pdfs', 'screenshots'].map((token) => ({ token })),
    },
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

/**
 * Exports that only the command line offers: `pdf-text` loads unpdf, whose
 * load inside the packaged app is not verified yet. The PDF files and
 * screenshots run in the app too (B154), see {@link desktopPdfOptions}.
 */
export const CLI_ONLY_EXPORTS = ['pdf-text'] as const;

/** Project meta key of the whole-run download cap of the PDF files export (B154). */
const PDF_MAX_BYTES_META = 'pdfExportMaxBytes';

/** The project's PDF download cap in bytes; the CLI's 2 GB default when none is stored. */
export function pdfExportMaxBytes(db: ProjectDb): number {
  const n = Number(db.getMeta(PDF_MAX_BYTES_META) ?? '');
  return Number.isSafeInteger(n) && n > 0 ? n : PDF_MAX_RUN_BYTES;
}

export function setPdfExportMaxBytes(db: ProjectDb, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`The download limit must be a whole number of bytes above 0, got ${bytes}.`);
  }
  db.setMeta(PDF_MAX_BYTES_META, String(bytes));
}

/**
 * What the `pdfs` export of a desktop run builds its requests from: the
 * app's crawl config as it holds it (secrets already decrypted, so auth
 * works where the CLI reading the saved envelope skips it) and the
 * project's byte cap. The same for the menu, the export sets and the
 * schedules, so all three fetch the files alike.
 */
export function desktopPdfOptions(
  config: CrawlConfig | null,
  db: ProjectDb,
): Pick<RunExportItemsOptions, 'pdfs'> {
  return {
    pdfs: {
      ...(config ? { crawlConfig: { config, secretsEnc: false } } : {}),
      maxBytes: pdfExportMaxBytes(db),
    },
  };
}

const cliOnlyMessage = (name: string): string =>
  `"${name}" is only available in the command line for now (freecrawl export --what ${name}); the desktop app skipped it.`;

/**
 * Save an export set from the desktop. A CLI-only export that is new to the
 * set is refused, nothing saved; one the stored set of that name already
 * holds (saved by the CLI) stays, since the editor cannot show or remove it
 * and a desktop run skips it anyway.
 */
export function saveDesktopExportSet(db: ProjectDb, set: ExportSet): ExportSet {
  const stored = new Set((listExportSets(db).find((s) => s.name === set.name.trim())?.what ?? []).map((w) => w.trim()));
  const bad = set.what
    .map((w) => w.trim())
    .filter((w) => (CLI_ONLY_EXPORTS as readonly string[]).includes(w) && !stored.has(w));
  if (bad.length > 0) {
    throw new Error(
      `${bad.map((b) => `"${b}"`).join(', ')} cannot be part of an export set made in the desktop app yet: ` +
        'they run from the command line only (freecrawl export --what ' +
        `${bad[0]}). Remove ${bad.length > 1 ? 'them' : 'it'} from the set.`,
    );
  }
  return saveExportSet(db, set);
}

/**
 * Run export items the way the desktop does: everything the CLI runs except
 * {@link CLI_ONLY_EXPORTS}, which are left out with one error entry each
 * (so a set saved by the CLI, or a schedule typed by hand, says why a file
 * is missing instead of running with a default user agent and no auth).
 */
export async function runDesktopExportItems(
  db: ProjectDb,
  outDir: string,
  items: readonly ExportItem[],
  options: RunExportItemsOptions = {},
): Promise<ExportOutcome> {
  const outcome: ExportOutcome = options.outcome ?? { files: [], errors: [], skipped: [] };
  const kept: ExportItem[] = [];
  for (const item of items) {
    if ((CLI_ONLY_EXPORTS as readonly string[]).includes(item.name)) {
      outcome.errors.push({ label: item.name, error: cliOnlyMessage(item.name) });
    } else {
      kept.push(item);
    }
  }
  // Nothing left to run: no folder, no manifest, only the errors above.
  if (kept.length === 0) return outcome;
  return runExportItems(db, outDir, kept, { ...options, outcome });
}

/** Run the saved set called `name` into `outDir`; throws before writing when there is none. */
export async function runSavedExportSet(
  db: ProjectDb,
  outDir: string,
  name: string,
  options: RunExportItemsOptions,
): Promise<ExportOutcome> {
  const set = findExportSet(db, name);
  return runDesktopExportItems(db, outDir, parseExportWhat(set.what.join(',')), {
    ...options,
    rawHeaders: options.rawHeaders || set.rawHeaders,
  });
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
