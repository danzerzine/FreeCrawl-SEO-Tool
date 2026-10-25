import {
  normalizeDisabledIssues,
  type CrawlSnapshot,
  type OverviewCounts,
} from '@freecrawl/shared-types';
import type { ProjectDb } from './project-db.js';

/**
 * Freezes the counts of the crawl in `db` as it stands now. Called once
 * per finished crawl; the result is what `crawl_runs.snapshot_json` and a
 * CI baseline file hold.
 *
 * `disabledChecks` adds the crawl config's silenced list to the project's:
 * the CLI never mirrors it into the project, and a crawl of a new site
 * wipes the mirrored copy, so the project alone can miss a check the user
 * turned off.
 */
export function buildCrawlSnapshot(
  db: Pick<ProjectDb, 'getSummary' | 'getOverviewCounts' | 'getDisabledIssues' | 'unrenderedPageCount'>,
  opts: { disabledChecks?: readonly string[] } = {},
): CrawlSnapshot {
  // `site` (soft-404 probe, bot-block sample) is a finding, not a count.
  const counts: Partial<OverviewCounts> = { ...db.getOverviewCounts() };
  delete counts.site;
  return {
    version: 1,
    summary: db.getSummary(),
    counts: counts as CrawlSnapshot['counts'],
    disabledChecks: normalizeDisabledIssues([
      ...db.getDisabledIssues(),
      ...(opts.disabledChecks ?? []),
    ]),
    unrenderedPages: db.unrenderedPageCount(),
  };
}
