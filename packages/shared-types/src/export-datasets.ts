import type { AiProvider } from './ai.js';
import type { SeoProvider } from './seo.js';
import type { UrlCategory } from './crawl.js';
import { ISSUE_CATEGORIES } from './issue-catalog.js';

/**
 * Tables the Export dialog can emit that are NOT views over `CrawlUrlRow`.
 *
 * The main URL tabs (Internal, Page Titles, Directives, …) all project the
 * same `urls` row, so the tabular exporter streams `CrawlUrlRow`s and the
 * dialog offers `CrawlUrlRow` keys as columns. The integration and
 * link-graph tabs have their own row shapes — a Search Console row is a
 * page joined with its clicks / impressions / inspection verdict, a Broken
 * Links row is one edge of the link graph — and each has its own DB query.
 * A dataset key names one of those queries; its column catalogue below
 * tells the dialog what to offer and the exporter what to read.
 *
 * AI and SEO Authority results are stored per provider, so those datasets
 * are keyed by provider — one sheet per provider, each with the metric
 * columns that provider actually returns.
 */
export type ExportDatasetKey =
  | 'images'
  | 'broken-links'
  | 'broken-links-by-target'
  | 'issues-long'
  | 'page-signals'
  | 'issue-inlinks'
  | 'selected-inlinks'
  | 'selected-outlinks'
  | 'sitemap-urls'
  | 'sitemap-files'
  | 'sitemap-reconciliation'
  | 'crawl-queue'
  | 'cookies'
  | 'response-headers'
  | 'page-html'
  | 'page-text'
  | 'pagespeed'
  | 'pagespeed-audits'
  | 'axe-violations'
  | 'crux'
  | 'spelling'
  | 'search-console'
  | 'analytics'
  | 'analytics-custom'
  | 'metrica'
  | 'webmaster'
  | 'webmaster-broken-links'
  | 'top-words'
  | 'link-suggestions'
  | `ai:${AiProvider}`
  | `seo:${SeoProvider}`;

export interface ExportDatasetColumn {
  /**
   * Dotted path into the dataset's row object — `gsc.clicks` reads
   * `row.gsc?.clicks`, so a page with no Search Console data exports an
   * empty cell rather than failing the row.
   */
  key: string;
  /** Column header, in English; translated through `labels.ts` in the UI. */
  header: string;
}

const PAGE: ExportDatasetColumn[] = [
  { key: 'url', header: 'URL' },
  { key: 'statusCode', header: 'Status' },
];

function pagespeedColumns(device: 'mobile' | 'desktop', label: string): ExportDatasetColumn[] {
  return [
    { key: `${device}.performance`, header: `${label} Performance` },
    { key: `${device}.lcp`, header: `${label} LCP` },
    { key: `${device}.cls`, header: `${label} CLS` },
    { key: `${device}.fcp`, header: `${label} FCP` },
    { key: `${device}.tbt`, header: `${label} TBT` },
    { key: `${device}.speedIndex`, header: `${label} Speed Index` },
    { key: `${device}.tti`, header: `${label} TTI` },
    { key: `${device}.inp`, header: `${label} INP` },
    { key: `${device}.status`, header: `${label} Result Status` },
    { key: `${device}.error`, header: `${label} Error` },
    { key: `${device}.fetchedAt`, header: `${label} Fetched At` },
  ];
}

function cruxColumns(device: 'phone' | 'desktop', label: string): ExportDatasetColumn[] {
  return [
    { key: `${device}.lcp`, header: `${label} LCP` },
    { key: `${device}.cls`, header: `${label} CLS` },
    { key: `${device}.inp`, header: `${label} INP` },
    { key: `${device}.fcp`, header: `${label} FCP` },
    { key: `${device}.ttfb`, header: `${label} TTFB` },
    { key: `${device}.status`, header: `${label} Result Status` },
    { key: `${device}.collectionPeriod`, header: `${label} Collection Period` },
    { key: `${device}.error`, header: `${label} Error` },
    { key: `${device}.fetchedAt`, header: `${label} Fetched At` },
  ];
}

const AI: ExportDatasetColumn[] = [
  ...PAGE,
  { key: 'ai.model', header: 'Model' },
  { key: 'ai.response', header: 'Response' },
  { key: 'ai.tokensIn', header: 'Tokens In' },
  { key: 'ai.tokensOut', header: 'Tokens Out' },
  { key: 'ai.status', header: 'Result Status' },
  { key: 'ai.error', header: 'Error' },
  { key: 'ai.fetchedAt', header: 'Fetched At' },
];

/**
 * One link row (`selected-inlinks`, `selected-outlinks`, `issue-inlinks`):
 * Screaming Frog's Bulk Export → Links columns, in its order, so a file
 * reads like theirs; then where a redirecting destination ends up, which
 * the Inlinks tab shows as Final Target.
 */
const LINK_COLUMNS: ExportDatasetColumn[] = [
  { key: 'type', header: 'Type' },
  { key: 'fromUrl', header: 'Source' },
  { key: 'toUrl', header: 'Destination' },
  { key: 'toSize', header: 'Size' },
  { key: 'altText', header: 'Alt Text' },
  { key: 'anchor', header: 'Anchor' },
  { key: 'toStatusCode', header: 'Status Code' },
  { key: 'toStatus', header: 'Status' },
  { key: 'follow', header: 'Follow' },
  { key: 'target', header: 'Target' },
  { key: 'rel', header: 'Rel' },
  { key: 'pathType', header: 'Path Type' },
  { key: 'linkPath', header: 'Link Path' },
  { key: 'linkPosition', header: 'Link Position' },
  { key: 'linkOrigin', header: 'Link Origin' },
  { key: 'toFinalUrl', header: 'Final Destination' },
  { key: 'toFinalStatusCode', header: 'Final Destination Status Code' },
];

const SEO_TAIL: ExportDatasetColumn[] = [
  { key: 'seo.status', header: 'Result Status' },
  { key: 'seo.error', header: 'Error' },
  { key: 'seo.fetchedAt', header: 'Fetched At' },
];

export const EXPORT_DATASET_COLUMNS: Record<ExportDatasetKey, ExportDatasetColumn[]> = {
  images: [
    { key: 'src', header: 'Image URL' },
    { key: 'fromUrl', header: 'Page URL' },
    { key: 'alt', header: 'Alt Text' },
    { key: 'width', header: 'Width' },
    { key: 'height', header: 'Height' },
    { key: 'isInternal', header: 'Internal' },
    { key: 'occurrences', header: 'Occurrences' },
  ],
  'broken-links': [
    { key: 'fromUrl', header: 'Source' },
    { key: 'fromStatusCode', header: 'Source Status' },
    { key: 'toUrl', header: 'Destination' },
    { key: 'toStatusCode', header: 'Destination Status' },
    { key: 'anchor', header: 'Anchor' },
    { key: 'rel', header: 'Rel' },
    { key: 'isInternal', header: 'Internal' },
    { key: 'position', header: 'Link Position' },
  ],
  'broken-links-by-target': [
    { key: 'toUrl', header: 'Destination' },
    { key: 'toStatusCode', header: 'Destination Status' },
    { key: 'linkCount', header: 'Links' },
    { key: 'linkingPages', header: 'Linking Pages' },
    { key: 'contentLinks', header: 'Content Links' },
  ],
  'issues-long': [
    { key: 'url', header: 'URL' },
    { key: 'issueKey', header: 'Issue' },
  ],
  'page-signals': [
    { key: 'url', header: 'URL' },
    { key: 'signal', header: 'Signal' },
    { key: 'detail', header: 'Detail' },
  ],
  'issue-inlinks': [{ key: 'issueKey', header: 'Issue' }, ...LINK_COLUMNS],
  'selected-inlinks': LINK_COLUMNS,
  'selected-outlinks': [
    ...LINK_COLUMNS,
    { key: 'crawlable', header: 'Crawlable' },
    { key: 'uncrawlableTag', header: 'Uncrawlable Tag' },
    { key: 'uncrawlableValue', header: 'Uncrawlable Value' },
  ],
  'response-headers': [
    { key: 'url', header: 'URL' },
    { key: 'name', header: 'Header' },
    { key: 'value', header: 'Value' },
  ],
  // Page bodies are far over Excel's 32,767-character cell limit: these two
  // are meant for the JSON Lines writer, not CSV / XLSX.
  'page-html': [
    { key: 'url', header: 'URL' },
    { key: 'statusCode', header: 'Status' },
    { key: 'contentType', header: 'Content Type' },
    { key: 'html', header: 'HTML' },
    // The JavaScript-rendered DOM, when the crawl rendered the page.
    { key: 'renderedHtml', header: 'Rendered HTML' },
  ],
  'page-text': [
    { key: 'url', header: 'URL' },
    { key: 'text', header: 'Text' },
  ],
  'sitemap-urls': [
    { key: 'url', header: 'URL' },
    { key: 'lastmod', header: 'Last Modified' },
    { key: 'sourceSitemap', header: 'Source Sitemap' },
    { key: 'sitemapCount', header: 'Sitemaps Listing It' },
  ],
  // The crawl against the sitemap, one row per URL of either (B61).
  'sitemap-reconciliation': [
    { key: 'url', header: 'URL' },
    { key: 'inCrawl', header: 'In Crawl' },
    { key: 'inSitemap', header: 'In Sitemap' },
    { key: 'statusCode', header: 'Status' },
    { key: 'indexability', header: 'Indexability' },
    { key: 'sitemapLastmod', header: 'Sitemap Lastmod' },
    { key: 'lastModifiedHeader', header: 'Last-Modified Header' },
    { key: 'lastmodDiffDays', header: 'Lastmod Difference (days)' },
    { key: 'verdict', header: 'Verdict' },
    { key: 'note', header: 'Note' },
  ],
  'sitemap-files': [
    { key: 'url', header: 'Sitemap' },
    { key: 'status', header: 'Status' },
    { key: 'bytes', header: 'Bytes' },
    { key: 'inflatedBytes', header: 'Bytes Uncompressed' },
    { key: 'urlCount', header: 'URLs' },
    { key: 'childCount', header: 'Child Sitemaps' },
    { key: 'duplicateEntries', header: 'Duplicate Entries' },
    { key: 'warnings', header: 'Warnings' },
    { key: 'error', header: 'Error' },
    { key: 'reason', header: 'Note' },
  ],
  'crawl-queue': [
    { key: 'url', header: 'URL' },
    { key: 'depth', header: 'Depth' },
    { key: 'seedUrl', header: 'Seed URL' },
  ],
  cookies: [
    { key: 'url', header: 'URL' },
    { key: 'name', header: 'Cookie' },
    { key: 'domain', header: 'Domain' },
    { key: 'path', header: 'Path' },
    { key: 'secure', header: 'Secure' },
    { key: 'httpOnly', header: 'HttpOnly' },
    { key: 'sameSite', header: 'SameSite' },
    { key: 'expires', header: 'Expires' },
    { key: 'setBy', header: 'Set By' },
    { key: 'thirdParty', header: 'Third Party' },
    { key: 'pageCookiesTotal', header: 'Page Cookies Total' },
    { key: 'pageCookiesTruncated', header: 'Page Cookies Truncated' },
  ],
  pagespeed: [
    ...PAGE,
    ...pagespeedColumns('mobile', 'Mobile'),
    ...pagespeedColumns('desktop', 'Desktop'),
    // B41: appended at the end so the order of the older columns does not change.
    { key: 'mobileOpportunityCount', header: 'Mobile Opportunities' },
    { key: 'mobileTopSavingsMs', header: 'Mobile Top Saving (ms)' },
    { key: 'desktopOpportunityCount', header: 'Desktop Opportunities' },
    { key: 'desktopTopSavingsMs', header: 'Desktop Top Saving (ms)' },
  ],
  // B41: one row per page x device x Lighthouse audit (insight, opportunity or diagnostic).
  'pagespeed-audits': [
    { key: 'url', header: 'URL' },
    { key: 'strategy', header: 'Strategy' },
    { key: 'auditId', header: 'Audit' },
    { key: 'kind', header: 'Kind' },
    { key: 'title', header: 'Title' },
    { key: 'score', header: 'Score' },
    { key: 'displayValue', header: 'Display Value' },
    { key: 'savingsMs', header: 'Savings (ms)' },
    { key: 'savingsBytes', header: 'Savings (bytes)' },
    { key: 'resourcesCount', header: 'Resources Count' },
    { key: 'resourcesJson', header: 'Resources JSON' },
    { key: 'lighthouseVersion', header: 'Lighthouse Version' },
    { key: 'fetchedAt', header: 'Fetched At' },
  ],
  // B40: one row per page x axe-core rule (violation, or needs-review when axe could not decide).
  'axe-violations': [
    { key: 'url', header: 'URL' },
    { key: 'ruleId', header: 'Rule' },
    { key: 'kind', header: 'Kind' },
    { key: 'impact', header: 'Impact' },
    { key: 'help', header: 'Help' },
    { key: 'helpUrl', header: 'Help URL' },
    { key: 'tags', header: 'WCAG Tags' },
    { key: 'nodes', header: 'Elements' },
    { key: 'firstSelector', header: 'First Selector' },
    { key: 'firstHtml', header: 'First HTML' },
  ],
  crux: [...PAGE, ...cruxColumns('phone', 'Phone'), ...cruxColumns('desktop', 'Desktop')],
  spelling: [
    { key: 'url', header: 'URL' },
    { key: 'lang', header: 'HTML Lang' },
    { key: 'wordCount', header: 'Word Count' },
    { key: 'language', header: 'Check Language' },
    { key: 'detectedLanguage', header: 'Detected Language' },
    { key: 'matchCount', header: 'Matches' },
    { key: 'status', header: 'Check Status' },
    { key: 'engine', header: 'Engine' },
    { key: 'error', header: 'Error' },
    { key: 'fetchedAt', header: 'Checked At' },
  ],
  'search-console': [
    ...PAGE,
    { key: 'gsc.clicks', header: 'Clicks' },
    { key: 'gsc.impressions', header: 'Impressions' },
    { key: 'gsc.ctr', header: 'CTR' },
    { key: 'gsc.position', header: 'Position' },
    { key: 'gsc.fetchedAt', header: 'Fetched At' },
    { key: 'inspection.verdict', header: 'Index Verdict' },
    { key: 'inspection.coverageState', header: 'Coverage State' },
    { key: 'inspection.robotsTxtState', header: 'Robots.txt State' },
    { key: 'inspection.indexingState', header: 'Indexing State' },
    { key: 'inspection.lastCrawlTime', header: 'Last Crawl Time' },
    { key: 'inspection.googleCanonical', header: 'Google Canonical' },
    { key: 'inspection.userCanonical', header: 'User Canonical' },
    { key: 'inspection.mobileVerdict', header: 'Mobile Usability' },
    { key: 'inspection.ampVerdict', header: 'AMP Verdict' },
    { key: 'inspection.richResultsVerdict', header: 'Rich Results Verdict' },
    { key: 'inspection.pageFetchState', header: 'Page Fetch State' },
    { key: 'inspection.crawledAs', header: 'Crawled As' },
    { key: 'inspection.sitemaps', header: 'Sitemaps' },
    { key: 'inspection.referringUrls', header: 'Referring URLs' },
    { key: 'inspection.referringCount', header: 'Referring Count' },
    { key: 'inspection.richResultTypes', header: 'Rich Result Types' },
    { key: 'inspection.richResultErrors', header: 'Rich Result Errors' },
    { key: 'inspection.richResultWarnings', header: 'Rich Result Warnings' },
    { key: 'inspection.richResultMessages', header: 'Rich Result Messages' },
  ],
  analytics: [
    ...PAGE,
    { key: 'ga4.sessions', header: 'Sessions' },
    { key: 'ga4.users', header: 'Users' },
    { key: 'ga4.pageviews', header: 'Pageviews' },
    { key: 'ga4.engagementRate', header: 'Engagement Rate' },
    { key: 'ga4.avgSessionDuration', header: 'Avg. Session Duration' },
    { key: 'ga4.fetchedAt', header: 'Fetched At' },
  ],
  // B37: the chosen custom GA4 fields, long form (one row per page, field and value).
  'analytics-custom': [
    ...PAGE,
    { key: 'custom.field', header: 'Field' },
    { key: 'custom.value', header: 'Value' },
    { key: 'custom.sessions', header: 'Sessions' },
  ],
  // Pageviews are hit-level (page URL); the rest are session-level,
  // counted for the landing page. The headers say so.
  metrica: [
    ...PAGE,
    { key: 'indexability', header: 'Indexability' },
    { key: 'metrica.pageviews', header: 'Pageviews (hits)' },
    { key: 'metrica.visits', header: 'Visits (landing page)' },
    { key: 'metrica.users', header: 'Users (landing page)' },
    { key: 'metrica.searchVisits', header: 'Search Visits (landing page)' },
    { key: 'metrica.fetchedAt', header: 'Fetched At' },
  ],
  // B39: pages Yandex last reported as removed from search (the Excluded pages view), then the
  // broken internal links it reports. Keyed by Yandex's URL, so a row can have no crawl page.
  webmaster: [
    { key: 'url', header: 'URL' },
    { key: 'reason', header: 'Yandex Reason' },
    { key: 'badHttpStatus', header: 'Yandex HTTP Status' },
    { key: 'targetUrl', header: 'Yandex Target URL' },
    { key: 'eventDate', header: 'Event Date' },
    { key: 'lastAccess', header: 'Last Access' },
    { key: 'crawlStatusCode', header: 'Crawl Status' },
    { key: 'crawlIndexability', header: 'Crawl Indexability' },
  ],
  'webmaster-broken-links': [
    { key: 'sourceUrl', header: 'Source URL' },
    { key: 'destinationUrl', header: 'Destination URL' },
    { key: 'discoveryDate', header: 'Discovered' },
    { key: 'sourceLastAccessDate', header: 'Source Last Access' },
    { key: 'destinationStatusCode', header: 'Destination Crawl Status' },
    { key: 'seenByCrawl', header: 'Also In Crawl Broken Links' },
  ],
  // B84: words or phrases of title, description and H1 (and stored bodies with --with-bodies).
  'top-words': [
    { key: 'scope', header: 'Scope' },
    { key: 'section', header: 'Section' },
    { key: 'n', header: 'N' },
    { key: 'gram', header: 'Gram' },
    { key: 'count', header: 'Count' },
    { key: 'pages', header: 'Pages' },
    { key: 'capped', header: 'Capped' },
  ],
  // B93: pages that lack links and the pages to add them from; one row per suggestion.
  'link-suggestions': [
    { key: 'targetUrl', header: 'Target URL' },
    { key: 'targetTitle', header: 'Target Title' },
    { key: 'targetInlinks', header: 'Target Inlinks' },
    { key: 'targetContentInlinks', header: 'Target Content Inlinks' },
    { key: 'targetLinkScore', header: 'Target Link Score' },
    { key: 'rank', header: 'Rank' },
    { key: 'sourceUrl', header: 'Source URL' },
    { key: 'sourceTitle', header: 'Source Title' },
    { key: 'closeness', header: 'Closeness %' },
    { key: 'sourceLinkScore', header: 'Source Link Score' },
    { key: 'sourceOutlinks', header: 'Source Outlinks' },
    { key: 'sameSection', header: 'Same Section' },
    { key: 'suggestedAnchor', header: 'Suggested Anchor' },
  ],
  'ai:openai': AI,
  'ai:anthropic': AI,
  'ai:ollama': AI,
  'ai:gemini': AI,
  'ai:openai-compatible': AI,
  'seo:ahrefs': [
    ...PAGE,
    { key: 'seo.metrics.domainRating', header: 'Domain Rating' },
    { key: 'seo.metrics.urlRating', header: 'URL Rating' },
    { key: 'seo.metrics.backlinks', header: 'Backlinks' },
    { key: 'seo.metrics.refDomains', header: 'Referring Domains' },
    ...SEO_TAIL,
  ],
  'seo:majestic': [
    ...PAGE,
    { key: 'seo.metrics.trustFlow', header: 'Trust Flow' },
    { key: 'seo.metrics.citationFlow', header: 'Citation Flow' },
    { key: 'seo.metrics.externalBacklinks', header: 'External Backlinks' },
    { key: 'seo.metrics.refDomains', header: 'Referring Domains' },
    ...SEO_TAIL,
  ],
  'seo:moz': [
    ...PAGE,
    { key: 'seo.metrics.domainAuthority', header: 'Domain Authority' },
    { key: 'seo.metrics.pageAuthority', header: 'Page Authority' },
    { key: 'seo.metrics.spamScore', header: 'Spam Score' },
    { key: 'seo.metrics.linkingDomains', header: 'Linking Domains' },
    ...SEO_TAIL,
  ],
  'seo:semrush': [
    ...PAGE,
    { key: 'seo.metrics.organicKeywords', header: 'Organic Keywords' },
    { key: 'seo.metrics.organicTraffic', header: 'Organic Traffic' },
    { key: 'seo.metrics.organicCost', header: 'Organic Cost' },
    { key: 'seo.metrics.adwordsKeywords', header: 'AdWords Keywords' },
    ...SEO_TAIL,
  ],
};

export function isExportDatasetKey(value: string): value is ExportDatasetKey {
  return Object.prototype.hasOwnProperty.call(EXPORT_DATASET_COLUMNS, value);
}

/**
 * The checks of the `page-signals` dataset (B136): the ten with a column of their own
 * plus eight derived from other columns or tables, in sidebar order.
 */
const PAGE_SIGNAL_SET: ReadonlySet<string> = new Set([
  'issues:hreflang-outside-head',
  'issues:title-outside-head',
  'issues:description-outside-head',
  'issues:meta-robots-outside-head',
  'issues:og-name-attribute',
  'issues:link-utm-internal',
  'issues:noindex-other-bot',
  'issues:pagination-loop',
  'issues:hreflang-not-canonical',
  'issues:hreflang-noindex-target',
  'issues:url-template-junk',
  'issues:url-internal-search',
  'issues:description-has-html',
  'issues:h2-missing',
  'issues:h2-duplicate',
  'issues:amp-target-broken',
  'issues:amp-target-redirect',
  'issues:pagination-non-indexable',
]);
export const PAGE_SIGNAL_CHECKS: readonly UrlCategory[] = ISSUE_CATEGORIES.filter((c) =>
  PAGE_SIGNAL_SET.has(c),
);
