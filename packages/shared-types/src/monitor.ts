import type { CrawlMode, CrawlSummary, OverviewCounts, UrlCategory } from './crawl.js';

/**
 * The counts of one finished crawl, frozen when it finished. Kept raw
 * (summary + overview counters + silenced checks) rather than as a list
 * of metric values, so a metric added later reads old snapshots too.
 * The same JSON is what a CI baseline file holds.
 */
export interface CrawlSnapshot {
  version: 1;
  summary: CrawlSummary;
  counts: Omit<OverviewCounts, 'site'>;
  /** `issues:*` categories silenced for this crawl; their metrics read as not computed. */
  disabledChecks: UrlCategory[];
}

/** One crawl's point in the Trends view: its finish time and one value per chosen metric (null = not computed). */
export interface MonitorHistoryRow {
  finishedAt: string;
  values: Record<string, number | null>;
}

/** One row of the project's crawl history (`crawl_runs`). */
export interface CrawlRun {
  id: number;
  /** ISO 8601. */
  finishedAt: string;
  startUrl: string;
  mode: CrawlMode;
  durationMs: number;
  /** App / CLI version that ran the crawl; null when the host did not say. */
  toolVersion: string | null;
  snapshot: CrawlSnapshot;
}
