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
