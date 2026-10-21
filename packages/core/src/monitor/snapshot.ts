import type { ProjectDb } from '@freecrawl/db';
import {
  ISSUE_GROUPS,
  issueCount,
  normalizeDisabledIssues,
  type CrawlSnapshot,
  type IssueCheckDef,
  type OverviewCounts,
  type UrlCategory,
} from '@freecrawl/shared-types';

/** A metric's value: a count, or null when the check was off or never computed. */
export type MetricValue = number | null;

type FixedMetric = (s: CrawlSnapshot) => MetricValue;

/**
 * The fixed metrics, in the order `listMetrics()` reports them. Every
 * reader goes through the snapshot JSON only, so a metric added here reads
 * snapshots written before it existed. `?? null` turns a field an older
 * snapshot lacks into "not computed" rather than a silent 0.
 */
const FIXED_METRICS: ReadonlyMap<string, FixedMetric> = new Map<string, FixedMetric>([
  ['urls.total', (s) => s.summary.total ?? null],
  ['urls.internal', (s) => s.counts.summary.totalInternalUrls ?? null],
  ['urls.external', (s) => s.counts.summary.totalExternalUrls ?? null],
  ['indexable', (s) => s.counts.indexability.indexable ?? null],
  ['non-indexable', (s) => s.counts.indexability.nonIndexable ?? null],
  ['noindex', (s) => s.counts.indexability.noindex ?? null],
  ['canonicalised', (s) => s.counts.indexability.canonicalised ?? null],
  ['blocked-robots', (s) => s.counts.indexability.blockedRobots ?? null],
  ['status.2xx', (s) => s.counts.responseCodes.success2xx ?? null],
  ['status.3xx', (s) => s.counts.responseCodes.redirect3xx ?? null],
  ['status.4xx', (s) => s.counts.responseCodes.clientError4xx ?? null],
  ['status.5xx', (s) => s.counts.responseCodes.serverError5xx ?? null],
  ['status.no-response', (s) => s.counts.responseCodes.noResponse ?? null],
  ['status.bot-blocked', (s) => s.counts.responseCodes.botBlocked ?? null],
  ['response-time.avg-ms', (s) => s.summary.avgResponseTimeMs ?? null],
]);

/** One exact status code, read from `CrawlSummary.byStatus`. */
const STATUS_CODE_METRIC = /^status\.(\d{3})$/;
/** How `listMetrics()` names the per-code family. */
const STATUS_CODE_PATTERN = 'status.<code>';

/** `issues:<key>` → its check, the same keys as `export --what issues:<key>`. */
const ISSUE_CHECKS: ReadonlyMap<string, IssueCheckDef> = new Map(
  ISSUE_GROUPS.flatMap((g) => g.items.map((i) => [i.category, i] as const)),
);

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
  db: Pick<ProjectDb, 'getSummary' | 'getOverviewCounts' | 'getDisabledIssues'>,
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
  };
}

/**
 * Every metric name `metricValue` accepts: the fixed counts, the
 * `status.<code>` family (any three-digit code, e.g. `status.404`), then
 * every issue check as `issues:<key>` in sidebar order.
 */
export function listMetrics(): string[] {
  return [...FIXED_METRICS.keys(), STATUS_CODE_PATTERN, ...ISSUE_CHECKS.keys()];
}

/**
 * Reads one metric from a snapshot. Null means "not computed": the check
 * was disabled for that crawl, or its counter was never filled. An
 * unknown name throws, listing the valid ones, so a typo in a rule file
 * fails loudly instead of reading as 0.
 */
export function metricValue(snapshot: CrawlSnapshot, name: string): MetricValue {
  const fixed = FIXED_METRICS.get(name);
  if (fixed) return fixed(snapshot);
  const code = STATUS_CODE_METRIC.exec(name);
  if (code) return snapshot.summary.byStatus[code[1]!] ?? 0;
  const check = ISSUE_CHECKS.get(name);
  if (check) {
    if (snapshot.disabledChecks.includes(check.category as UrlCategory)) return null;
    return issueCount(snapshot.counts.issues, check) ?? null;
  }
  throw new Error(`Unknown metric: ${name}. Valid metrics: ${listMetrics().join(', ')}`);
}
