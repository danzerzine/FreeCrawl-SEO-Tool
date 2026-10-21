/**
 * Trends view data: the project's crawl history as one value per chosen
 * metric per crawl. Kept out of `index.ts` (and free of Electron) so it
 * runs, and is tested, on its own.
 */

import type { ProjectDb } from '@freecrawl/db';
import { historyRows, latestAndPrevious, listMetrics } from '@freecrawl/core';
import type { MonitorHistoryRow } from '@freecrawl/shared-types';

/** How `listMetrics()` names the per-code family; the picker offers real codes instead. */
const STATUS_CODE_PATTERN = 'status.<code>';

/**
 * Rows of the current site, oldest first. The site is the newest history
 * row's start URL (the resolved one, not the typed `lastStartUrl`); a
 * project without history has none. An unknown metric throws, listing the
 * valid ones.
 */
export function monitorHistory(
  db: ProjectDb,
  metrics: readonly string[],
  limit?: number,
): MonitorHistoryRow[] {
  return historyRows(db, metrics, { limit }).rows;
}

/**
 * Every metric name the picker can offer: `status.<code>` becomes one
 * `status.404`-style name per code the newest crawl saw, in code order;
 * without history, none.
 */
export function monitorMetricNames(db: Pick<ProjectDb, 'latestCrawlRunStartUrl' | 'listCrawlRuns'>): string[] {
  const byStatus = latestAndPrevious(db)?.current.snapshot.summary.byStatus ?? {};
  const codes = Object.keys(byStatus)
    .filter((c) => /^\d{3}$/.test(c))
    .sort()
    .map((c) => `status.${c}`);
  return listMetrics().flatMap((m) => (m === STATUS_CODE_PATTERN ? codes : [m]));
}
