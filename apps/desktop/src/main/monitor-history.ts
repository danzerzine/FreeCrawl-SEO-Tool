/**
 * Trends view data: the project's crawl history as one value per chosen
 * metric per crawl. Kept out of `index.ts` (and free of Electron) so it
 * runs, and is tested, on its own.
 */

import type { ProjectDb } from '@freecrawl/db';
import { listMetrics, metricValue } from '@freecrawl/core';
import type { MonitorHistoryRow } from '@freecrawl/shared-types';

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
  const startUrl = db.latestCrawlRunStartUrl();
  if (startUrl === null) return [];
  return db.listCrawlRuns(startUrl, limit).map((run) => ({
    finishedAt: run.finishedAt,
    values: Object.fromEntries(metrics.map((m) => [m, metricValue(run.snapshot, m)])),
  }));
}

/** Every metric name the picker can offer. */
export function monitorMetricNames(): string[] {
  return listMetrics();
}
