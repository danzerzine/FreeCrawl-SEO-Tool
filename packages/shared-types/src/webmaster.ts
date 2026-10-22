/**
 * Yandex Webmaster integration: shared types.
 *
 * Webmaster is connected with its own pasted OAuth token (scopes `webmaster:hostinfo` and
 * `webmaster:verify`) kept in the credential store under the `webmaster` integration. Rows
 * are keyed by the Webmaster host id (for example `https:example.com:443`).
 */

/** Why a Webmaster call failed, for the UI to word in the user's language. */
export type WebmasterErrorCode =
  | 'not-connected'
  | 'token-format'
  | 'token-rejected'
  | 'access-denied'
  | 'quota-exceeded'
  | 'host-not-verified'
  | 'invalid-user'
  | 'network'
  | 'cancelled'
  | 'api';

/** One host of the connected Yandex account. */
export interface WebmasterHost {
  hostId: string;
  hostName: string;
  verified: boolean;
}

/** One row of the removal-events list, dates already converted to UTC ISO. */
export interface WebmasterEventRow {
  url: string;
  title: string | null;
  /** `APPEARED_IN_SEARCH` or `REMOVED_FROM_SEARCH`. */
  event: string;
  /** Yandex's `excluded_url_status`. */
  reason: string | null;
  badHttpStatus: number | null;
  targetUrl: string | null;
  eventDate: string | null;
  lastAccess: string | null;
}

/** One broken internal link reported by Yandex, dates in UTC ISO. */
export interface WebmasterBrokenLinkRow {
  sourceUrl: string;
  destinationUrl: string;
  discoveryDate: string | null;
  sourceLastAccessDate: string | null;
}

/** Progress record kept in project_meta `webmasterRun:<hostId>` after every page. */
export interface WebmasterRunProgress {
  startedAt: string;
  eventsOffset: number;
  eventsDone: boolean;
  linksOffset: number;
  linksDone: boolean;
  eventsCount: number | null;
  linksCount: number | null;
  /** UTC ISO time at which Yandex's daily quota opens again, set by a QUOTA_EXCEEDED stop. */
  exceededUntil?: string | null;
}

/** Written to project_meta `webmasterFetchMeta:<hostId>` when both phases finish. */
export interface WebmasterFetchMeta {
  hostName: string;
  fetchedAt: string;
  eventRows: number;
  brokenLinkRows: number;
  /** Rows whose URL normalised to nothing: counted, not stored. */
  skippedRows?: number;
  truncatedAtCap: boolean;
}

/** Per-project settings, `integrationSettings:webmaster`. */
export interface WebmasterIntegrationSettings {
  hostId: string;
  hostName: string;
}

export function defaultWebmasterSettings(): WebmasterIntegrationSettings {
  return { hostId: '', hostName: '' };
}

/** Presets of the Excluded pages view. */
export type WebmasterExcludedPreset = 'all' | 'indexable-in-crawl' | 'not-in-crawl';
/** Presets of the Broken links view. */
export type WebmasterBrokenPreset = 'all' | 'not-seen-by-crawl';

/** One row of the Excluded pages view: Yandex's removal event next to the crawl of the same URL. */
export interface WebmasterExcludedRow {
  /** `urls.id` when the crawl has the URL, else null (the row is «not in crawl»). */
  id: number | null;
  url: string;
  title: string | null;
  reason: string | null;
  badHttpStatus: number | null;
  targetUrl: string | null;
  eventDate: string | null;
  lastAccess: string | null;
  crawlStatusCode: number | null;
  crawlIndexability: string | null;
}

/** One row of the Broken links view. */
export interface WebmasterBrokenRow {
  sourceUrl: string;
  destinationUrl: string;
  discoveryDate: string | null;
  sourceLastAccessDate: string | null;
  /** The crawl's status for the destination; null when the crawl has no such URL. */
  destinationStatusCode: number | null;
  /** The crawl also found a link from source to destination whose target answers 400 or worse. */
  seenByCrawl: boolean;
}

export interface WebmasterQueryResult<T> {
  rows: T[];
  total: number;
  /** The last finished pull of the host; null before any pull («no pull yet»). */
  meta: WebmasterFetchMeta | null;
}
