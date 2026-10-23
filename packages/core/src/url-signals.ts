import type { ProjectDb } from '@freecrawl/db';
import {
  PAGE_SIGNAL_CHECKS,
  SIGNAL_CHECKS_ALWAYS_FILLED,
  URL_SIGNAL_CHECKS,
  urlSignalCell,
  YES_NO_URL_COLUMNS,
  type CrawlUrlRow,
  type YesNoUrlColumn,
} from '@freecrawl/shared-types';

/**
 * The yes/no signal columns (B136) whose check this project's crawls never
 * filled: the migrations add the columns as `NOT NULL DEFAULT 0`, so a stored 0
 * cannot say «not checked» and the exports write these cells blank instead of
 * `No`. Read from the project's own `checksFilled` record, once per export.
 */
export function m5ColumnsNotChecked(db: ProjectDb): Set<string> {
  const filled = db.checksFilled();
  return new Set(
    YES_NO_URL_COLUMNS.filter((col) => {
      const check = URL_SIGNAL_CHECKS[col];
      return !SIGNAL_CHECKS_ALWAYS_FILLED.includes(check) && !filled.has(check);
    }),
  );
}

/** Checks of the `page-signals` file that this project's crawls never filled, so the file has no rows for them. */
export function pageSignalChecksNotFilled(db: ProjectDb): string[] {
  const filled = db.checksFilled();
  return PAGE_SIGNAL_CHECKS.filter(
    (check) => !SIGNAL_CHECKS_ALWAYS_FILLED.includes(check) && !filled.has(check),
  );
}

/** Why a `page-signals` file with no rows was not written (the bulk path's `skipped`, the CLI's `skipped`). */
export function pageSignalsEmptyReason(db: ProjectDb): string {
  const later = PAGE_SIGNAL_CHECKS.length - SIGNAL_CHECKS_ALWAYS_FILLED.length;
  return pageSignalChecksNotFilled(db).length === later
    ? 'This project was crawled by a build without the newer page checks, so these signals were not checked.'
    : 'No page has any of these signals.';
}

/** The warning on a written `page-signals` file when some checks were not filled; empty when all were. */
export function pageSignalsWarnings(db: ProjectDb): string[] {
  const missing = pageSignalChecksNotFilled(db);
  return missing.length === 0
    ? []
    : [`not checked by the build that crawled this project, so no rows for: ${missing.join(', ')}`];
}

const YES_NO = new Set<string>(YES_NO_URL_COLUMNS);

/**
 * URL rows with the yes/no signal columns among `columns` replaced by their
 * export cell ({@link urlSignalCell}): the rows are handed on as they come, the
 * cells rewritten in place (each row is a fresh object of the reader). Rows pass
 * untouched when no signal column is asked for.
 */
export function withSignalCells(
  rows: Iterable<CrawlUrlRow>,
  columns: readonly string[],
  mode: 'labels' | 'machine',
  notChecked: ReadonlySet<string>,
): Iterable<CrawlUrlRow> {
  const wanted = columns.filter((c): c is YesNoUrlColumn => YES_NO.has(c));
  if (wanted.length === 0) return rows;
  return (function* () {
    for (const row of rows) {
      const cells = row as unknown as Record<string, unknown>;
      for (const col of wanted) cells[col] = urlSignalCell(row, col, mode, notChecked);
      yield row;
    }
  })();
}
