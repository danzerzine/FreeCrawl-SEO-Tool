/**
 * Readers of the project's crawl history (`crawl_runs`) shared by the CLI
 * (`history`, `check`) and the desktop (Trends, alerts). The site is the
 * newest row's start URL, the one the crawler resolved, not the typed
 * `lastStartUrl`, which can differ (redirect, missing slash).
 */
import type { ProjectDb } from '@freecrawl/db';
import type { CrawlRun, IssueTrend, MonitorHistoryRow } from '@freecrawl/shared-types';
import { assertMetric, listMetrics, metricValue } from './snapshot.js';

type HistoryDb = Pick<ProjectDb, 'latestCrawlRunStartUrl' | 'listCrawlRuns'>;

/** The newest crawl and the one before it of the same start URL. */
export interface LatestCrawls {
  current: CrawlRun;
  /** Null after the first crawl of a site. */
  previous: CrawlRun | null;
}

/** The newest crawl and its previous; null when no crawl has finished in the project. */
export function latestAndPrevious(db: HistoryDb): LatestCrawls | null {
  const startUrl = db.latestCrawlRunStartUrl();
  if (startUrl === null) return null;
  const runs = db.listCrawlRuns(startUrl, 2);
  const current = runs.at(-1);
  if (!current) return null;
  return { current, previous: runs.length > 1 ? runs[0]! : null };
}

/**
 * Every check's count in the newest crawl against the previous one of the
 * same start URL; null with fewer than two crawls. A check null in either
 * snapshot (off, or absent from an older build) is left out.
 */
export function issueTrend(db: HistoryDb): IssueTrend | null {
  const pair = latestAndPrevious(db);
  if (!pair?.previous) return null;
  const { current, previous } = pair;
  const checks: IssueTrend['checks'] = {};
  for (const m of listMetrics()) {
    if (!m.startsWith('issues:')) continue;
    const before = metricValue(previous.snapshot, m);
    const after = metricValue(current.snapshot, m);
    if (before !== null && after !== null) checks[m] = { previous: before, change: after - before };
  }
  return {
    previousFinishedAt: previous.finishedAt,
    toolVersionChanged: current.toolVersion !== previous.toolVersion,
    checks,
  };
}

/**
 * One row per crawl of a start URL (the newest row's unless given), oldest
 * first, with one value per metric. Every metric is checked first, so an
 * unknown name throws, listing the valid ones, also on a project without
 * history.
 */
export function historyRows(
  db: HistoryDb,
  metrics: readonly string[],
  opts: { startUrl?: string; limit?: number } = {},
): { startUrl: string | null; rows: MonitorHistoryRow[] } {
  for (const m of metrics) assertMetric(m);
  const startUrl = opts.startUrl ?? db.latestCrawlRunStartUrl();
  if (startUrl === null) return { startUrl, rows: [] };
  const rows = db.listCrawlRuns(startUrl, opts.limit).map((run) => ({
    finishedAt: run.finishedAt,
    values: Object.fromEntries(metrics.map((m) => [m, metricValue(run.snapshot, m)])),
  }));
  return { startUrl, rows };
}
