import type { CrawlUrlRow } from './crawl.js';

/**
 * Column labels for URL-row exports (CSV / XLSX), keyed by the `CrawlUrlRow`
 * field the column writes. The grid's column definitions
 * (`apps/desktop/.../tabs/columns.ts`) read their headers from here, so the
 * file a user exports carries the same names the grid shows. Labels are
 * English and unlocalised: the CLI and bulk files have no UI locale, and
 * Screaming Frog exports are English too. The desktop grid translates the
 * same strings for display only.
 *
 * Note the Indexability Status column writes `indexabilityReason`.
 */
export const URL_COLUMN_HEADERS = {
  url: 'URL',
  statusCode: 'Status',
  contentKind: 'Type',
  indexability: 'Indexability',
  indexabilityReason: 'Indexability Status',
  title: 'Title 1',
  titleLength: 'Title 1 Length',
  metaDescription: 'Meta Description 1',
  metaDescriptionLength: 'Meta Description 1 Length',
  h1: 'H1-1',
  h1Length: 'H1-1 Length',
  h1Count: 'H1 Count',
  h2Count: 'H2 Count',
  h2First: 'H2-1',
  wordCount: 'Word Count',
  mainWordCount: 'Content Area Word Count',
  canonical: 'Canonical Link Element 1',
  metaRobots: 'Meta Robots 1',
  xRobotsTag: 'X-Robots-Tag 1',
  responseTimeMs: 'Response Time',
  contentType: 'Content Type',
  contentLength: 'Size (Bytes)',
  depth: 'Crawl Depth',
  inlinks: 'Inlinks',
  outlinks: 'Outlinks',
  linkScore: 'Link Score',
  imagesCount: 'Images',
  imagesMissingAlt: 'Imgs Missing Alt',
  redirectTarget: 'Redirect URL',
  redirectChainLength: 'Chain Length',
  redirectFinalUrl: 'Final URL',
  canonicalChainLength: 'Canonical Chain',
  canonicalFinalUrl: 'Final Canonical',
  redirectLoop: 'Loop',
  clusterId: 'Cluster',
  clusterSize: 'Cluster Size',
  contentHash: 'Content Hash',
  simhash: 'SimHash',
  hsts: 'HSTS',
  csp: 'CSP',
  xFrameOptions: 'X-Frame-Options',
  xContentTypeOptions: 'X-Content-Type-Options',
  mixedContentActive: 'Mixed Active',
  mixedContentPassive: 'Mixed Passive',
  missingSriCount: 'Missing SRI',
  insecureFormActionCount: 'Insecure Form Action',
  paginationNext: 'rel=next',
  paginationPrev: 'rel=prev',
  paginationSequenceBreak: 'Sequence Break',
  hreflangCount: 'Hreflang Count',
  hreflangs: 'Hreflang Targets',
  hreflangSelfRefMissing: 'Self-Ref Missing',
  hreflangTargetIssues: 'Target Issues',
  amphtml: 'AMP HTML',
  mobileAlternate: 'Mobile Alternate',
  schemaTypes: 'Schema Types',
  schemaBlockCount: 'JSON-LD Blocks',
  schemaInvalidCount: 'Invalid JSON-LD',
  schemaDuplicateIds: 'Duplicate @id',
  metaRefresh: 'Meta Refresh',
  metaRefreshUrl: 'Meta Refresh URL',
  jsRedirectUrl: 'JS Redirect URL',
  extractionResults: 'Extracted Data',
  customSearchHits: 'Custom Search Hits',
  brokenBookmarks: 'Broken Bookmarks',
  emptyAnchorCount: 'Empty Anchors',
  jsOnlyLinksCount: 'Uncrawlable Links',
  canonicalCount: 'Canonical Count',
  isExternal: 'Is External',
  statusText: 'Status Text',
  canonicalHttp: 'HTTP Canonical',
  crawledAt: 'Crawl Timestamp',
  // B136: the module-5 page signals. The wording is the check's label in issue-catalog.ts
  // (the detail panel's string for the bot list), so one phrase names column, check and finding.
  hreflangOutsideHead: 'Hreflang Outside <head>',
  titleOutsideHead: 'Title Outside <head>',
  descriptionOutsideHead: 'Description Outside <head>',
  metaRobotsOutsideHead: 'Meta Robots Outside <head>',
  ogNameAttr: 'OG Tag Uses name=',
  internalUtmLinks: 'Internal Link with UTM',
  metaNoindexBots: 'Noindex for Other Engines',
  paginationLoop: 'Pagination Loop',
  hreflangNotCanonical: 'Hreflang on Non-Canonical Page',
  hreflangNoindexTargets: 'Noindex Alternate',
  jsH1Changed: 'JS H1 Changed',
  jsCanonicalChanged: 'JS Canonical Changed',
  jsLinksChanged: 'JS Links Changed',
  jsTextChanged: 'JS Text Changed',
  renderDiff: 'Render Diff',
  consoleErrors: 'Console Errors',
  failedResources: 'Failed Resources',
  consoleLog: 'Console Log',
  markupErrors: 'Markup Errors',
  markupCodes: 'Markup Error Codes',
  cssBytes: 'CSS Bytes',
  cssUnusedBytes: 'Unused CSS Bytes',
  jsBytes: 'JS Bytes',
  jsUnusedBytes: 'Unused JS Bytes',
  cookiesTotal: 'Cookies',
  cookiesTruncated: 'Cookies Truncated',
  cookiesJson: 'Cookies JSON',
} as const;

/** Header for a `CrawlUrlRow` key: the grid label, else the key split into Title Case words. */
export function urlColumnHeader(key: string): string {
  const known = (URL_COLUMN_HEADERS as Record<string, string>)[key];
  if (known !== undefined) return known;
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The module-5 page signals (B136): yes/no columns of the full pages export,
 * in the order they are written, one per check of the `urls` table.
 */
export const YES_NO_URL_COLUMNS = [
  'hreflangOutsideHead',
  'titleOutsideHead',
  'descriptionOutsideHead',
  'metaRobotsOutsideHead',
  'ogNameAttr',
  'internalUtmLinks',
  'metaNoindexBots',
  'paginationLoop',
  'hreflangNotCanonical',
  'hreflangNoindexTargets',
] as const satisfies readonly (keyof CrawlUrlRow)[];

export type YesNoUrlColumn = (typeof YES_NO_URL_COLUMNS)[number];

/** The `issues:*` check each yes/no column is the per-page fact behind. */
export const URL_SIGNAL_CHECKS: Record<YesNoUrlColumn, string> = {
  hreflangOutsideHead: 'issues:hreflang-outside-head',
  titleOutsideHead: 'issues:title-outside-head',
  descriptionOutsideHead: 'issues:description-outside-head',
  metaRobotsOutsideHead: 'issues:meta-robots-outside-head',
  ogNameAttr: 'issues:og-name-attribute',
  internalUtmLinks: 'issues:link-utm-internal',
  metaNoindexBots: 'issues:noindex-other-bot',
  paginationLoop: 'issues:pagination-loop',
  hreflangNotCanonical: 'issues:hreflang-not-canonical',
  hreflangNoindexTargets: 'issues:hreflang-noindex-target',
};

/**
 * Signal checks that are not in the db package's `LATER_CHECKS`: they predate the
 * `checksFilled` record, or read data every project has, so any project answers
 * them. A test pins this list against `LATER_CHECKS`.
 */
export const SIGNAL_CHECKS_ALWAYS_FILLED: readonly string[] = [
  'issues:hreflang-outside-head',
  'issues:url-template-junk',
  'issues:url-internal-search',
  'issues:description-has-html',
  'issues:h2-missing',
  'issues:pagination-non-indexable',
];

/**
 * One cell of a yes/no signal column. Blank (null) outside the check's scope
 * (external, not HTML, not answered 2xx: the `STATUS_GATED_ISSUES` scope) and
 * when the project's crawl never filled the check (`notChecked`), so `Yes` per
 * column equals the check's count. `labels` mode gives `Yes` / `No`; `machine`
 * mode keeps the stored count or bot list.
 */
export function urlSignalCell(
  row: CrawlUrlRow,
  key: YesNoUrlColumn,
  mode: 'labels' | 'machine',
  notChecked?: ReadonlySet<string>,
): string | number | null {
  const status = row.statusCode;
  if (
    row.isExternal ||
    row.contentKind !== 'html' ||
    status === null ||
    status === undefined ||
    status < 200 ||
    status >= 300 ||
    notChecked?.has(key)
  ) {
    return null;
  }
  const v = row[key];
  if (mode === 'machine') return v ?? null;
  return (typeof v === 'string' ? v !== '' : (v ?? 0) > 0) ? 'Yes' : 'No';
}
