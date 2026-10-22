/**
 * Faz 7 — Google OAuth + Search Console shared types.
 *
 * The Google integrations (Search Console, Analytics 4, Sheets) all
 * authenticate through the same OAuth "loopback" keystone: the user
 * brings their own Google Cloud OAuth Desktop client (BYOC — id +
 * secret entered in Settings → Integrations), the main process opens
 * the consent screen in the system browser, and a short-lived
 * localhost HTTP server catches the redirect. Refresh tokens are
 * encrypted at rest with `safeStorage`, exactly like API keys.
 */

import type { MetricaMetrics } from './metrica.js';

/**
 * One connected Google account for an integration. A user can link
 * several accounts to the same integration (e.g. their own Search
 * Console plus a client's), each with its own refresh token; the
 * per-project settings pick which one a crawl's data comes from.
 */
export interface GoogleAccount {
  /** Opaque stable id — the key the token store and `account_id`
   *  columns use. Never the email, so a renamed/aliased address can't
   *  orphan the stored rows. */
  accountId: string;
  /** The Google account address, when the userinfo call succeeded. */
  email: string | null;
  /** ISO timestamp this account was connected. */
  connectedAt: string;
}

/** Connection state of one OAuth-BYOC Google integration. */
export interface GoogleAuthState {
  /** True once at least one account is connected. */
  connected: boolean;
  /** First connected account's email — kept for single-account callers. */
  email: string | null;
  /** ISO timestamp the first connection was established. */
  connectedAt: string | null;
  /** Every connected account, in connection order. */
  accounts: GoogleAccount[];
}

/** Result of an interactive `googleAuthStart` consent flow. */
export interface GoogleAuthResult {
  ok: boolean;
  /** Human-readable reason when `ok` is false (cancelled, denied, …). */
  error: string | null;
  state: GoogleAuthState;
}

/** One verified property from the user's Search Console account. */
export interface GscSite {
  /** Property URL — `https://example.com/` or `sc-domain:example.com`. */
  siteUrl: string;
  /** `siteOwner` / `siteFullUser` / `siteRestrictedUser` / `siteUnverifiedUser`. */
  permissionLevel: string;
}

/** Per-URL Search Console metrics for a date range. */
export interface GscMetrics {
  clicks: number;
  impressions: number;
  /** Click-through rate, 0–1. */
  ctr: number;
  /** Average position (1 = top of the results). */
  position: number;
  /** ISO timestamp of the pull this row came from. */
  fetchedAt: string;
}

/** One Search Console tab row — a crawled page joined with its GSC data. */
export interface GscRow {
  /** `urls.id` the Detail panel opens on a row click; null for a GSC URL
   *  the crawl never reached (the orphan presets). */
  id: number | null;
  url: string;
  statusCode: number | null;
  /** Null when this page has no Search Console impressions in the range. */
  gsc: GscMetrics | null;
  /** Null when URL Inspection has not been run for this page. */
  inspection: GscInspectionResult | null;
}

/** One rich-result item found on a page, with its counted issues (B38). */
export interface GscRichResultItem {
  name: string;
  errors: number;
  warnings: number;
  /** Up to 5 distinct issue messages, each cut to 300 characters. */
  messages: string[];
}

/** One rich-result type Google detected on a page, e.g. `Product snippets`. */
export interface GscRichResultType {
  type: string;
  items: GscRichResultItem[];
}

/** Result of a GSC URL Inspection API call for one URL. */
export interface GscInspectionResult {
  /** Overall verdict — `PASS` / `NEUTRAL` / `PARTIAL` / `FAIL` /
   *  `VERDICT_UNSPECIFIED`. */
  verdict: string | null;
  /** Human-readable coverage state, e.g. "Submitted and indexed". */
  coverageState: string | null;
  robotsTxtState: string | null;
  indexingState: string | null;
  /** ISO timestamp of Google's last crawl. */
  lastCrawlTime: string | null;
  /** The canonical Google picked for this page. */
  googleCanonical: string | null;
  /** The canonical the page declared. */
  userCanonical: string | null;
  /** Mobile Usability verdict — `PASS` / `FAIL` / `NEUTRAL` /
   *  `VERDICT_UNSPECIFIED`. Null when inspection predates this column. */
  mobileVerdict: string | null;
  /** AMP result verdict, when the page declares an AMP version. */
  ampVerdict: string | null;
  /** Rich-results verdict across all detected structured-data items. */
  richResultsVerdict: string | null;
  /** B38 fields. Null / absent means the page was inspected before this
   *  version (or the facet does not exist), never «none». */
  pageFetchState?: string | null;
  crawledAs?: string | null;
  /** Sitemaps Google lists for the page; not a complete list. */
  sitemaps?: string[] | null;
  /** Up to 20 pages Google found linking here. */
  referringUrls?: string[] | null;
  /** True number of referring pages Google reported. */
  referringCount?: number | null;
  richResults?: GscRichResultType[] | null;
  status: 'ok' | 'error';
  error: string | null;
  fetchedAt: string;
}

/**
 * Quick-filter presets for the Search Console tab, mirroring Screaming
 * Frog's "verified in GSC" filter dropdown. `all` / `with-data` /
 * `without-data` are the legacy values the MCP `query_gsc` tool still
 * sends; the rest are the SF-parity presets. Presets past
 * `non-indexable-with-data` need URL Inspection data to have been run;
 * `orphan` widens the candidate set to GSC URLs missing from the crawl.
 */
export type GscPreset =
  | 'all'
  | 'with-data'
  | 'without-data'
  | 'clicks-above-0'
  | 'non-indexable-with-data'
  | 'orphan'
  | 'not-on-google'
  | 'indexable-not-indexed'
  | 'on-google-with-issues'
  | 'canonical-mismatch'
  | 'not-mobile-friendly'
  | 'amp-invalid'
  | 'rich-result-invalid'
  | 'rich-result-warnings';

/** Date-range presets for a GSC pull. `16m` is the API's 16-month max;
 *  `custom` uses the explicit `startDate` / `endDate`. */
export type GscDateRange = '7d' | '28d' | '90d' | '16m' | 'custom';
/** Device dimension filter — API values (or `all` for no filter). */
export type GscDeviceFilter = 'all' | 'DESKTOP' | 'MOBILE' | 'TABLET';
/** Search-appearance type the metrics are pulled for. */
export type GscSearchType =
  | 'web'
  | 'image'
  | 'video'
  | 'news'
  | 'discover'
  | 'googleNews';
/** Query dimension filter operator. */
export type GscQueryFilterMode =
  | 'none'
  | 'contains'
  | 'notContains'
  | 'equals'
  | 'notEquals'
  | 'includingRegex'
  | 'excludingRegex';

/**
 * Per-project Google Search Console integration settings — the FreeCrawl
 * equivalent of Screaming Frog's "API Access → Google Search Console"
 * dialog. Stored per project (encrypted credentials stay separate); the
 * fetch reads these to shape the Search Analytics query and to decide
 * whether newly-discovered GSC URLs are crawled.
 */
export interface GscIntegrationSettings {
  /** Which connected Google account this project pulls from. Empty means
   *  "the first connected account" — the state every pre-multi-account
   *  project is in. */
  accountId: string;
  /** Last-selected Search Console property (`siteUrl`). */
  property: string;
  dateRange: GscDateRange;
  /** `YYYY-MM-DD`, only used when `dateRange === 'custom'`. */
  startDate: string;
  endDate: string;
  deviceFilter: GscDeviceFilter;
  /** ISO-3166-1 alpha-3 country code, lowercase (e.g. `usa`); '' = none. */
  countryFilter: string;
  searchType: GscSearchType;
  queryFilterMode: GscQueryFilterMode;
  queryFilterValue: string;
  /** Match trailing vs non-trailing-slash URL variants when comparing
   *  GSC URLs against crawled URLs (SF: "Match Trailing and Non-Trailing
   *  Slash URLs"). */
  matchSlash: boolean;
  /** Match uppercase vs lowercase URL variants (SF: "Match Uppercase &
   *  Lowercase URLs"). */
  matchCase: boolean;
  /** Cap the number of rows pulled (SF: "Limit Max Results"). */
  limitMaxResults: boolean;
  maxResults: number;
  /** SF: "Crawl New URLs Discovered In Google Search Console" — after a
   *  pull, feed GSC URLs that aren't in the crawl into the crawler. */
  crawlNewUrls: boolean;
}

/** Factory for the default GSC settings (a fresh object each call so the
 *  shared default can't be mutated). */
export function defaultGscSettings(): GscIntegrationSettings {
  return {
    accountId: '',
    property: '',
    dateRange: '28d',
    startDate: '',
    endDate: '',
    deviceFilter: 'all',
    countryFilter: '',
    searchType: 'web',
    queryFilterMode: 'none',
    queryFilterValue: '',
    matchSlash: true,
    matchCase: false,
    limitMaxResults: true,
    maxResults: 100000,
    crawlNewUrls: false,
  };
}

/** Metadata describing the most recent GSC pull for the active project. */
export interface GscFetchMeta {
  /** The Search Console property the data was pulled from. */
  property: string;
  /** Date range (inclusive), `YYYY-MM-DD`. */
  startDate: string;
  endDate: string;
  fetchedAt: string;
  /** Number of page rows Search Console returned. */
  rowCount: number;
}

/** One Google Analytics 4 property the connected account can read. */
export interface Ga4Property {
  /** API resource name, e.g. `properties/123456789`. */
  propertyId: string;
  /** Friendly label, e.g. `"Acme – Marketing Site"`. */
  displayName: string;
  /** Display name of the parent account, for disambiguation. */
  accountName: string;
}

/** Per-page Google Analytics 4 metrics for a date range. */
export interface Ga4Metrics {
  sessions: number;
  users: number;
  pageviews: number;
  /** Engagement rate, 0–1 (the share of engaged sessions). */
  engagementRate: number;
  /** Average session duration in seconds. */
  avgSessionDuration: number;
  fetchedAt: string;
}

/** One Analytics tab row — a crawled page joined with its GA4 data. */
export interface Ga4Row {
  /** `urls.id` — what the Detail panel opens when the row is clicked. */
  id: number;
  url: string;
  statusCode: number | null;
  /** Null when the page had no GA4 traffic in the range. */
  ga4: Ga4Metrics | null;
  /** B37: stored values of the chosen custom fields, by field; absent when none are chosen. */
  custom?: Record<string, Ga4CustomValue[]>;
}

/** Combined per-URL Analytics view — GSC Search Analytics + GA4 +
 *  Yandex Metrica + GSC URL Inspection, returned by `urlAnalyticsGet` for
 *  the detail panel's Analytics sub-tab. Any field is null when no data
 *  exists. */
export interface UrlAnalyticsDetail {
  url: string;
  gsc: GscMetrics | null;
  ga4: Ga4Metrics | null;
  /** The project's selected counter; pageviews hit-level, the rest
   *  session-level by landing page (see `MetricaMetrics`). */
  metrica: MetricaMetrics | null;
  inspection: GscInspectionResult | null;
  /** B37: every stored value of each chosen GA4 custom field for this page, by field. */
  ga4Custom?: Record<string, Ga4CustomValue[]>;
}

/**
 * Per-project Google Analytics 4 integration settings. Smaller than the
 * GSC equivalent — the Data API call takes no dimension filters here —
 * but it carries the same account/property selection so a project
 * remembers which of several linked GA4 accounts it reports on.
 */
export interface Ga4IntegrationSettings {
  /** Which connected Google account this project pulls from. Empty means
   *  "the first connected account". */
  accountId: string;
  /** Last-selected property resource name (`properties/<id>`). */
  property: string;
  /** Friendly label for that property, for the fetch meta line. */
  propertyName: string;
  /** Trailing window in days. */
  days: 7 | 28 | 90;
  /** B37: extra GA4 metrics pulled next to the five fixed ones (API names, at most
   *  `GA4_MAX_CUSTOM_METRICS`). A project saved before this version reads as `[]`. */
  customMetrics: string[];
  /** B37: extra dimensions, one report each (at most `GA4_MAX_CUSTOM_DIMENSIONS`). */
  customDimensions: string[];
}

export const GA4_MAX_CUSTOM_METRICS = 10;
export const GA4_MAX_CUSTOM_DIMENSIONS = 5;

/** Factory for the default GA4 settings (fresh object each call). */
export function defaultGa4Settings(): Ga4IntegrationSettings {
  return {
    accountId: '',
    property: '',
    propertyName: '',
    days: 28,
    customMetrics: [],
    customDimensions: [],
  };
}

/** Defaults plus a stored settings blob; a missing or malformed custom list reads as `[]`. */
export function mergeGa4Settings(stored: Record<string, unknown> | null | undefined): Ga4IntegrationSettings {
  const names = (v: unknown, cap: number): string[] =>
    Array.isArray(v)
      ? Array.from(new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))).slice(0, cap)
      : [];
  const merged = { ...defaultGa4Settings(), ...(stored ?? {}) } as Ga4IntegrationSettings;
  merged.customMetrics = names(stored?.['customMetrics'], GA4_MAX_CUSTOM_METRICS);
  merged.customDimensions = names(stored?.['customDimensions'], GA4_MAX_CUSTOM_DIMENSIONS);
  return merged;
}

/** One field of a GA4 property from the Data API `getMetadata` call. */
export interface Ga4Field {
  apiName: string;
  uiName: string;
  description: string;
  /** True for the property's own custom metrics and dimensions. */
  customDefinition: boolean;
  category: string;
  kind: 'metric' | 'dimension';
}

/** How one chosen custom field fared in the last pull. */
export interface Ga4CustomFieldStatus {
  field: string;
  kind: 'metric' | 'dimension';
  /** Stored rows for the field. */
  rows: number;
  ok: boolean;
  /** Why the field is not ok: Google's message, or «not pulled: …». */
  error?: string;
}

/** One stored value of a custom field for a page. */
export interface Ga4CustomValue {
  value: string;
  /** Sessions with this value (dimensions); null for a metric. */
  sessions: number | null;
}

/** Metadata describing the most recent GA4 pull for the active project. */
export interface Ga4FetchMeta {
  /** API resource name (`properties/<id>`) the data was pulled from. */
  property: string;
  /** Friendly label for the property — what the UI shows. */
  propertyName: string;
  /** Inclusive date range, `YYYY-MM-DD`. */
  startDate: string;
  endDate: string;
  fetchedAt: string;
  /** Number of page rows GA4 returned. */
  rowCount: number;
  /** B37: every chosen custom field, finished ones included; absent on a pull from before this version. */
  customFields?: Ga4CustomFieldStatus[];
  /** B37: what happened to the fields not pulled, in words for the user. */
  customMessage?: string | null;
  /** B37: distinct stored GA4 page URLs with no crawled row (tracking-parameter or slash variants). */
  unmatchedUrls?: number;
}

/**
 * B37 — the field picker's list: custom fields first, then the standard ones; inside a block
 * dimensions before metrics, then by label. `query` matches the API name or the label.
 */
export function ga4PickerFields(fields: Ga4Field[], query: string): Ga4Field[] {
  const q = query.trim().toLowerCase();
  const kindRank = (f: Ga4Field): number => (f.kind === 'dimension' ? 0 : 1);
  return fields
    .filter((f) => !q || f.apiName.toLowerCase().includes(q) || f.uiName.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(b.customDefinition) - Number(a.customDefinition) ||
        kindRank(a) - kindRank(b) ||
        a.uiName.localeCompare(b.uiName),
    );
}

/**
 * B37 — tick or untick one field. Adding past the limit (ten metrics, five dimensions) is
 * refused and says which list is full; unticking always works.
 */
export function ga4ToggleCustom(
  metrics: string[],
  dimensions: string[],
  field: Ga4Field,
): { metrics: string[]; dimensions: string[]; blocked?: 'metrics' | 'dimensions' } {
  const isMetric = field.kind === 'metric';
  const list = isMetric ? metrics : dimensions;
  if (list.includes(field.apiName)) {
    const next = list.filter((n) => n !== field.apiName);
    return isMetric ? { metrics: next, dimensions } : { metrics, dimensions: next };
  }
  const cap = isMetric ? GA4_MAX_CUSTOM_METRICS : GA4_MAX_CUSTOM_DIMENSIONS;
  if (list.length >= cap) return { metrics, dimensions, blocked: isMetric ? 'metrics' : 'dimensions' };
  const next = [...list, field.apiName];
  return isMetric ? { metrics: next, dimensions } : { metrics, dimensions: next };
}

/** B37 — what a table cell shows: a metric's number, or a dimension's top value by sessions plus «+N». */
export function ga4CellText(values: Ga4CustomValue[] | undefined): string {
  if (!values || values.length === 0) return '';
  const top = [...values].sort((a, b) => (b.sessions ?? 0) - (a.sessions ?? 0))[0]!;
  return values.length > 1 ? `${top.value} +${values.length - 1}` : top.value;
}
