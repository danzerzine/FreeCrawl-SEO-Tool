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
  /**
   * The crawled site, as the history row holds it. Only in a file written by
   * `check --write-snapshot`, so `--baseline` can refuse another site's;
   * older files lack it.
   */
  startUrl?: string;
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

/**
 * One monitoring rule as a rule file holds it (`docs/specs/M13-monitoring.md`).
 * The core's `parseRules` checks it and fills the defaults.
 */
export interface MonitorRuleSpec {
  name: string;
  metric: string;
  vs?: 'absolute' | 'previous';
  change?: 'count' | 'percent';
  op: '>' | '>=' | '<' | '<=' | '==' | '!=';
  value: number;
  level?: 'fail' | 'warn';
}

/**
 * Where the desktop sends an alert: the Slack / Telegram / Email
 * integrations, or the crawl-finished webhook of Settings → Webhook.
 */
export type AlertChannelId = 'slack' | 'telegram' | 'email' | 'webhook';

export const ALERT_CHANNELS: readonly AlertChannelId[] = ['slack', 'telegram', 'email', 'webhook'];

/** A project's alert setup as Settings → Alerts edits it. */
export interface MonitorAlertsConfig {
  rules: MonitorRuleSpec[];
  /** Channels turned on for this project. */
  channels: AlertChannelId[];
}

/** What the Alerts panel loads: the saved setup plus what it can pick from. */
export interface MonitorAlertsState extends MonitorAlertsConfig {
  /** Every metric name a rule may use (`listMetrics()`). */
  metrics: string[];
  /** Channels whose credentials (or webhook URL) are filled in. */
  configured: AlertChannelId[];
}

/** One channel's delivery outcome; `detail` never carries a secret. */
export interface AlertDelivery {
  channel: AlertChannelId;
  ok: boolean;
  detail: string;
}
