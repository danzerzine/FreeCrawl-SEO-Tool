import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ProjectDb } from '@freecrawl/db';
import { fillThresholdLabel } from '@freecrawl/shared-types';
import type { CrawlSummary, OverviewCounts, ReportBranding } from '@freecrawl/shared-types';
import { writeExportFile } from './export-file.js';

/**
 * Self-contained HTML audit report for a finished crawl. Single-file
 * deliverable — no external CSS, no JS, no remote assets — so it can be
 * emailed, archived, or hosted as-is. Designed to be readable on a
 * laptop screen and printable on A4 in portrait without re-flowing.
 *
 * Sections:
 *   - Header: site, run timestamp, total URL count, crawl duration.
 *   - Summary cards: status mix, indexability mix, payload mix.
 *   - Top issues table: every non-zero issue with its count, ranked by
 *     severity bucket (errors → warnings → info).
 *   - Sample tables: top 25 slowest URLs, top 25 deepest URLs, top 25
 *     URLs with the most outlinks. Capped on purpose — the user goes to
 *     the live UI for full data.
 *
 * Streams to disk via `Readable.from` + `pipeline` so memory stays
 * bounded even on a 1M-URL crawl.
 */
export interface HtmlReportOptions {
  startUrl: string;
  generatedAt?: Date;
  /** White-label header: brand name, logo, accent colour, "prepared by". */
  branding?: ReportBranding;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

const STYLE = `
body { font: 13px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
  color: #1f2937; background: #f9fafb; margin: 0; padding: 24px; }
h1 { font-size: 20px; margin: 0 0 4px; color: var(--accent, #111827); }
.hdr { display: flex; align-items: center; gap: 14px; }
.hdr .logo { max-height: 44px; max-width: 160px; object-fit: contain; }
.recs { padding-left: 20px; margin: 0; }
.recs li { margin: 0 0 8px; }
.muted { color: #6b7280; font-size: 12px; }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(4, 1fr); margin: 16px 0 24px; }
.card { background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; }
.card .label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: .04em; }
.card .value { font-size: 22px; font-weight: 600; margin-top: 4px; color: #111827; }
section { margin: 28px 0 0; }
section > h2 { font-size: 14px; margin: 0 0 8px; color: #111827;
  border-bottom: 2px solid var(--accent, #e5e7eb); padding-bottom: 4px; }
table { width: 100%; border-collapse: collapse; background: white;
  border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #f3f4f6;
  font-size: 12px; vertical-align: top; }
th { background: #f9fafb; font-weight: 600; color: #374151; font-size: 11px;
  text-transform: uppercase; letter-spacing: .04em; }
tr:last-child td { border-bottom: none; }
.right { text-align: right; }
.mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px; word-break: break-all; }
.sev-error { color: #dc2626; font-weight: 600; }
.sev-warn  { color: #d97706; font-weight: 600; }
.sev-info  { color: #2563eb; }
@media print { body { background: white; padding: 12px; } .card { break-inside: avoid; } }
`;

interface IssueDef {
  key: keyof OverviewCounts['issues'];
  label: string;
  severity: 'error' | 'warn' | 'info';
}

const ISSUES: IssueDef[] = [
  { key: 'titleMissing', label: 'Title Missing', severity: 'error' },
  { key: 'titleDuplicate', label: 'Title Duplicate', severity: 'error' },
  { key: 'titleTooLong', label: 'Title Too Long (>{{titleMaxChars}})', severity: 'warn' },
  { key: 'titleTooShort', label: 'Title Too Short (<{{titleMinChars}})', severity: 'warn' },
  { key: 'metaMissing', label: 'Meta Description Missing', severity: 'error' },
  { key: 'metaDuplicate', label: 'Meta Description Duplicate', severity: 'error' },
  {
    key: 'metaTooLong',
    label: 'Meta Description Too Long (>{{descriptionMaxChars}})',
    severity: 'warn',
  },
  {
    key: 'metaTooShort',
    label: 'Meta Description Too Short (<{{descriptionMinChars}})',
    severity: 'warn',
  },
  { key: 'h1Missing', label: 'H1 Missing', severity: 'error' },
  { key: 'h2Missing', label: 'H2 Missing', severity: 'info' },
  { key: 'h2Duplicate', label: 'H2 Duplicate', severity: 'info' },
  { key: 'descriptionHasHtml', label: 'Description Contains HTML', severity: 'info' },
  { key: 'h1Duplicate', label: 'H1 Duplicate', severity: 'error' },
  { key: 'h1Multiple', label: 'Multiple H1s', severity: 'warn' },
  { key: 'headingSkippedLevel', label: 'Skipped Heading Level', severity: 'warn' },
  { key: 'multipleCanonicals', label: 'Multiple Canonicals', severity: 'error' },
  { key: 'canonicalMissing', label: 'Canonical Missing', severity: 'warn' },
  { key: 'canonicalToNon200', label: 'Canonical → Non-200', severity: 'error' },
  { key: 'canonicalToRedirect', label: 'Canonical → Redirect', severity: 'warn' },
  { key: 'canonicalToNoindex', label: 'Canonical → Noindex', severity: 'error' },
  { key: 'canonicalMismatch', label: 'Canonical HTTP/HTML Mismatch', severity: 'error' },
  { key: 'contentThin', label: 'Thin Content (<{{thinContentWords}} words)', severity: 'warn' },
  { key: 'nearDuplicate', label: 'Near-Duplicate Content', severity: 'warn' },
  { key: 'duplicateContentExact', label: 'Duplicate Content (exact)', severity: 'error' },
  { key: 'responseSlow', label: 'Slow Response (>1s)', severity: 'warn' },
  { key: 'responseVerySlow', label: 'Very Slow Response (>3s)', severity: 'error' },
  { key: 'pageLarge', label: 'Large Page (>1MB)', severity: 'warn' },
  { key: 'urlTooLong', label: 'URL Too Long (>2048)', severity: 'warn' },
  { key: 'urlManyParams', label: 'Many Query Params (>5)', severity: 'info' },
  { key: 'redirectLoop', label: 'Redirect Loop', severity: 'error' },
  { key: 'redirectChainLong', label: 'Long Redirect Chain (>3)', severity: 'warn' },
  { key: 'redirectSelf', label: 'Self-Redirect', severity: 'error' },
  { key: 'mixedContent', label: 'Mixed Content', severity: 'error' },
  { key: 'imageMissingAlt', label: 'Image Missing Alt', severity: 'warn' },
  { key: 'metaRefreshUsed', label: 'Meta Refresh Used', severity: 'warn' },
  { key: 'compressionMissing', label: 'Compression Missing', severity: 'warn' },
  { key: 'cspMissing', label: 'CSP Missing', severity: 'info' },
  { key: 'hstsMissing', label: 'HSTS Missing', severity: 'info' },
  { key: 'xFrameOptionsMissing', label: 'X-Frame-Options Missing', severity: 'info' },
  { key: 'xContentTypeOptionsMissing', label: 'X-Content-Type-Options Missing', severity: 'info' },
  { key: 'viewportMissing', label: 'Viewport Missing', severity: 'warn' },
  { key: 'langMissing', label: 'lang Attribute Missing', severity: 'info' },
  { key: 'ogMissing', label: 'OpenGraph Tags Missing', severity: 'info' },
  { key: 'ogNameAttribute', label: 'OG Tag Uses name=', severity: 'info' },
  { key: 'noindexOtherBot', label: 'Noindex for Another Search Engine', severity: 'info' },
  { key: 'twitterMissing', label: 'Twitter Card Missing', severity: 'info' },
  { key: 'structuredDataMissing', label: 'JSON-LD Missing', severity: 'info' },
  { key: 'structuredDataInvalid', label: 'Invalid JSON-LD', severity: 'error' },
  { key: 'paginationBroken', label: 'Pagination Broken', severity: 'error' },
  { key: 'paginationNonIndexable', label: 'Paginated Page Not Indexable', severity: 'warn' },
  { key: 'paginationLoop', label: 'Pagination Loop', severity: 'warn' },
  { key: 'paginationMultiple', label: 'Multiple Pagination URLs', severity: 'warn' },
  { key: 'hreflangXDefaultMissing', label: 'Hreflang x-default Missing', severity: 'info' },
  { key: 'hreflangInvalidCode', label: 'Hreflang Invalid Code', severity: 'error' },
  { key: 'hreflangSelfRefMissing', label: 'Hreflang Self-Ref Missing', severity: 'error' },
  { key: 'hreflangReciprocityMissing', label: 'Hreflang Reciprocity Missing', severity: 'warn' },
  { key: 'hreflangTargetIssues', label: 'Hreflang Target Issues', severity: 'error' },
  { key: 'hreflangNoindexTarget', label: 'Hreflang Noindex Alternate', severity: 'warn' },
  { key: 'hreflangNotCanonical', label: 'Hreflang on Non-Canonical Page', severity: 'warn' },
  { key: 'faviconMissing', label: 'Favicon Missing', severity: 'info' },
  { key: 'charsetMissing', label: 'Charset Missing', severity: 'warn' },
  { key: 'charsetMismatch', label: 'Charset Mismatch (HTTP vs HTML)', severity: 'warn' },
  { key: 'canonicalOutsideHead', label: 'Canonical Outside <head>', severity: 'warn' },
  { key: 'hreflangOutsideHead', label: 'Hreflang Outside <head>', severity: 'warn' },
  { key: 'titleOutsideHead', label: 'Title Outside <head>', severity: 'warn' },
  { key: 'descriptionOutsideHead', label: 'Description Outside <head>', severity: 'warn' },
  { key: 'metaRobotsOutsideHead', label: 'Meta Robots Outside <head>', severity: 'warn' },
  { key: 'langContentMismatch', label: 'Lang ≠ Content Language', severity: 'warn' },
  { key: 'soft404', label: 'Soft 404', severity: 'warn' },
  { key: 'redirectChain', label: 'Redirect Chain (2+ hops)', severity: 'warn' },
  { key: 'blockedByRobots', label: 'Linked URL Blocked by robots.txt', severity: 'warn' },
  { key: 'noindexJsInjected', label: 'Noindex Added by JavaScript', severity: 'warn' },
  { key: 'titleChangedByJs', label: 'Title Changed by JavaScript', severity: 'warn' },
  { key: 'h1ChangedByJs', label: 'H1 Changed by JavaScript', severity: 'warn' },
  { key: 'canonicalChangedByJs', label: 'Canonical Changed by JavaScript', severity: 'warn' },
  { key: 'linksChangedByJs', label: 'Links Changed by JavaScript', severity: 'info' },
  { key: 'textChangedByJs', label: 'Text Changed by JavaScript', severity: 'info' },
  { key: 'consoleErrors', label: 'Console Errors', severity: 'warn' },
  { key: 'failedResources', label: 'Failed Resources', severity: 'warn' },
  { key: 'markupErrors', label: 'HTML Markup Errors', severity: 'warn' },
  { key: 'duplicateIds', label: 'Duplicate id Attributes', severity: 'warn' },
  { key: 'ampValidationErrors', label: 'AMP Validation Errors', severity: 'warn' },
  { key: 'ampTargetBroken', label: 'AMP Version Broken', severity: 'warn' },
  { key: 'ampTargetRedirect', label: 'AMP Version Redirects', severity: 'warn' },
  { key: 'highBoilerplate', label: 'High Boilerplate (>50%)', severity: 'warn' },
  { key: 'contentAreaNotFound', label: 'Content Area Not Found', severity: 'info' },
  { key: 'nonIndexableInSitemap', label: 'Non-Indexable in Sitemap', severity: 'error' },
  { key: 'non200InSitemap', label: 'Non-200 in Sitemap', severity: 'error' },
  { key: 'redirectInSitemap', label: 'Redirect in Sitemap', severity: 'warn' },
  { key: 'crawledNotInSitemap', label: 'Crawled, Not in Sitemap', severity: 'info' },
  { key: 'brokenLinksInternal', label: 'Broken Internal Links', severity: 'error' },
  { key: 'brokenLinksExternal', label: 'Broken External Links', severity: 'warn' },
  { key: 'titleMultiple', label: 'Multiple <title> Tags', severity: 'error' },
  { key: 'h1Empty', label: 'H1 Empty', severity: 'error' },
  { key: 'h1TooLong', label: 'H1 Too Long (>70)', severity: 'warn' },
  { key: 'urlFragment', label: 'Fragment in URL', severity: 'info' },
  { key: 'urlTemplateJunk', label: 'Template Junk in URL', severity: 'warn' },
  { key: 'urlInternalSearch', label: 'Internal Search URL', severity: 'info' },
  { key: 'linkUtmInternal', label: 'Internal Link with UTM', severity: 'warn' },
  { key: 'urlSpaces', label: 'Spaces in URL', severity: 'warn' },
  { key: 'imageEmptyAlt', label: 'Image Empty Alt', severity: 'info' },
  { key: 'imageDuplicateAlt', label: 'Image Duplicate Alt', severity: 'warn' },
  { key: 'brokenBookmark', label: 'Broken Bookmarks', severity: 'warn' },
  { key: 'linkEmptyAnchor', label: 'Empty Anchor Text', severity: 'warn' },
  { key: 'titlePixelWidthTooLong', label: 'Title Pixel Width >{{titleMaxPx}}px', severity: 'warn' },
  {
    key: 'metaPixelWidthTooLong',
    label: 'Meta Description Pixel Width >{{descriptionMaxPx}}px',
    severity: 'warn',
  },
  {
    key: 'titlePixelWidthTooShort',
    label: 'Title Pixel Width <{{titleMinPx}}px',
    severity: 'info',
  },
  {
    key: 'metaPixelWidthTooShort',
    label: 'Meta Description Pixel Width <{{descriptionMinPx}}px',
    severity: 'info',
  },
  { key: 'insecureFormAction', label: 'Insecure Form Action (HTTPS → HTTP)', severity: 'error' },
  { key: 'missingSri', label: 'Missing SRI (3rd-party subresource)', severity: 'info' },
  { key: 'ttfbSlow', label: 'TTFB Slow (>600ms)', severity: 'warn' },
  { key: 'ttfbVerySlow', label: 'TTFB Very Slow (>1.8s)', severity: 'error' },
  { key: 'cookieNoSecure', label: 'Cookies Missing Secure (HTTPS)', severity: 'error' },
  { key: 'cookieNoHttpOnly', label: 'Cookies Missing HttpOnly', severity: 'warn' },
  { key: 'cookieNoSameSite', label: 'Cookies Missing SameSite', severity: 'info' },
  { key: 'queryStringTooLong', label: 'Query String >100 Chars', severity: 'info' },
  { key: 'folderDepthTooDeep', label: 'Folder Depth >4', severity: 'info' },
  { key: 'http2NotSupported', label: 'HTTP/2 Not Advertised', severity: 'info' },
  { key: 'http3NotSupported', label: 'HTTP/3 Not Advertised', severity: 'info' },
  { key: 'renderBlocking', label: 'Render-Blocking Head Resources >5', severity: 'warn' },
  { key: 'keepaliveDisabled', label: 'Keep-Alive Disabled (Connection: close)', severity: 'warn' },
  { key: 'titlePlaceholder', label: 'Title Placeholder (Untitled / Default)', severity: 'error' },
];

const SEV_RANK: Record<IssueDef['severity'], number> = { error: 0, warn: 1, info: 2 };

/**
 * One-line, action-oriented advice per issue for the "Recommendations"
 * section. Report copy stays English (the file is shared and machine-
 * read); the fallback covers checks without a tailored line.
 */
const RECOMMENDATIONS: Partial<Record<IssueDef['key'], string>> = {
  titleMissing:
    'Write a unique, descriptive <title> ({{titleMinChars}}–{{titleMaxChars}} characters) for every page; it is the strongest on-page ranking and click-through signal.',
  titleDuplicate: 'Give each page its own title — duplicates make search engines pick one page and suppress the rest.',
  titleTooLong:
    'Trim titles to about {{titleMaxChars}} characters so they are not truncated in results; front-load the primary keyword.',
  titleTooShort:
    'Expand titles below {{titleMinChars}} characters with the page topic and brand so they describe the page.',
  titlePlaceholder: 'Replace placeholder titles ("Untitled", "Home") with real page titles.',
  metaMissing:
    'Add a meta description ({{descriptionMinChars}}–{{descriptionMaxChars}} characters) that summarises the page and invites the click.',
  metaDuplicate: 'Write page-specific meta descriptions; duplicated snippets lower click-through and get rewritten by Google.',
  metaTooLong:
    'Shorten meta descriptions to about {{descriptionMaxChars}} characters so the snippet is not cut off.',
  metaTooShort:
    'Extend meta descriptions below {{descriptionMinChars}} characters to make full use of the snippet.',
  h2Missing:
    'Break long content into sections with H2 subheadings; they help readers and search engines scan the page.',
  h2Duplicate: 'Give each page its own first H2 instead of a heading repeated from a template.',
  descriptionHasHtml:
    'Remove HTML tags from the meta description; search engines show them as text or drop the description.',
  h1Missing: 'Add a single H1 that states the page topic; screen readers and crawlers use it as the page headline.',
  h1Duplicate: 'Make H1s unique per page so each page targets its own topic.',
  h1Multiple: 'Keep one H1 per page and demote the rest to H2/H3.',
  headingSkippedLevel: 'Restore the heading hierarchy (H1 → H2 → H3) — skipped levels hurt accessibility and outline parsing.',
  multipleCanonicals: 'Leave exactly one canonical tag per page; conflicting canonicals are ignored by Google.',
  canonicalMissing: 'Add a self-referencing canonical to indexable pages to consolidate parameter and duplicate variants.',
  canonicalToNon200: 'Point canonicals at live 200 pages; a canonical to an error page is discarded.',
  canonicalToRedirect: 'Canonicalise directly to the final URL instead of a redirecting one.',
  canonicalToNoindex: 'Never canonicalise to a noindex page — the signals contradict each other.',
  canonicalMismatch: 'Align HTML and HTTP canonicals so they name the same URL.',
  contentThin: 'Expand thin pages with substantive content or consolidate them into stronger pages.',
  nearDuplicate: 'Merge or differentiate near-duplicate pages, or canonicalise them to the preferred version.',
  duplicateContentExact: 'Serve exact-duplicate pages from one URL and redirect or canonicalise the others.',
  responseSlow: 'Bring server response time under 1 s: cache HTML, tune the database, use a CDN.',
  responseVerySlow: 'Investigate pages over 3 s first — they hurt crawl budget and Core Web Vitals most.',
  ttfbSlow: 'Reduce time-to-first-byte with server-side caching and faster hosting.',
  ttfbVerySlow: 'TTFB above 1.8 s fails Core Web Vitals; profile the backend and add edge caching.',
  pageLarge: 'Cut page weight: compress images, defer non-critical scripts, remove unused CSS.',
  urlTooLong: 'Shorten URLs; keep them readable and under ~100 characters where possible.',
  urlManyParams: 'Reduce query parameters and canonicalise parameterised variants to a clean URL.',
  redirectLoop: 'Break redirect loops — they return no content and waste crawl budget.',
  redirectChainLong: 'Collapse redirect chains so every link points straight to the final URL.',
  redirectSelf: 'Fix URLs that redirect to themselves; they never resolve.',
  mixedContent: 'Load every sub-resource over HTTPS to remove "Not Secure" warnings.',
  imageMissingAlt: 'Add descriptive alt text to content images (empty alt for decorative ones).',
  imageEmptyAlt: 'Confirm images with empty alt are decorative; give meaningful images real alt text.',
  imageDuplicateAlt: 'Vary alt text so different images are not described identically.',
  metaRefreshUsed: 'Replace meta refresh with a server-side 301 redirect.',
  compressionMissing: 'Enable gzip or Brotli compression for text responses.',
  cspMissing: 'Add a Content-Security-Policy header to mitigate XSS and injection.',
  hstsMissing: 'Send Strict-Transport-Security on HTTPS pages so browsers never downgrade to HTTP.',
  xFrameOptionsMissing: 'Send X-Frame-Options (or CSP frame-ancestors) to prevent clickjacking.',
  xContentTypeOptionsMissing: 'Send X-Content-Type-Options: nosniff.',
  viewportMissing: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> for mobile rendering.',
  langMissing: 'Set the html lang attribute so browsers, screen readers and search engines know the page language.',
  ogMissing: 'Add Open Graph title, description and image so shares render a rich preview.',
  ogNameAttribute:
    'Write og:* tags with property=, as the OpenGraph protocol asks; some readers ignore name=.',
  noindexOtherBot:
    'Check that the noindex is meant only for that search engine: the engine this crawl acts as indexes the page.',
  twitterMissing: 'Add Twitter Card tags (card type + image) for X/Twitter previews.',
  structuredDataMissing: 'Add JSON-LD structured data for the page type to qualify for rich results.',
  structuredDataInvalid: 'Fix JSON-LD syntax errors; invalid blocks are ignored entirely.',
  paginationBroken: 'Point rel=next / rel=prev at live pages in the sequence.',
  paginationNonIndexable: 'Let each page of the series index itself: no noindex, a self canonical.',
  paginationLoop: 'Make rel=next lead forward to the last page, never back to an earlier one.',
  paginationMultiple: 'Declare one rel=next and one rel=prev per page; search engines read only the first.',
  hreflangXDefaultMissing: 'Add an x-default hreflang for visitors who match no listed language.',
  hreflangInvalidCode: 'Use valid ISO 639-1 language (and optional ISO 3166-1 region) codes in hreflang.',
  hreflangSelfRefMissing: 'Include a self-referencing hreflang on every page in the cluster.',
  hreflangReciprocityMissing: 'Make hreflang annotations reciprocal — every target must link back.',
  hreflangTargetIssues: 'Point hreflang at live, indexable, self-canonical pages.',
  hreflangNoindexTarget: 'Remove the noindex from the alternate or drop it from the hreflang set.',
  hreflangNotCanonical: 'Put hreflang on the canonical page and list only canonical URLs.',
  faviconMissing: 'Add a favicon; it appears next to the site in mobile results.',
  charsetMissing: 'Declare the character encoding (meta charset or Content-Type header).',
  charsetMismatch: 'Make the Content-Type header charset match the meta charset — browsers obey the header.',
  canonicalOutsideHead: 'Move rel=canonical into <head>; search engines ignore it in <body>.',
  hreflangOutsideHead: 'Move hreflang <link> tags into <head>; search engines ignore them in <body>.',
  titleOutsideHead: 'Move <title> into <head>; in <body> it is read only when <head> has none.',
  descriptionOutsideHead:
    'Move the meta description into <head>; in <body> it is read only when <head> has none.',
  metaRobotsOutsideHead:
    'Move the robots meta into <head>; search engines may ignore it in <body>.',
  urlTemplateJunk:
    'Fix the script or template that writes the link; the URL holds an unfilled value.',
  urlInternalSearch:
    'Keep site search results out of the crawl: noindex them or stop linking to them.',
  linkUtmInternal: 'Drop utm_* from internal links; they restart the visit in analytics.',
  langContentMismatch: 'Set html[lang] to the language the page is actually written in.',
  soft404: 'Return 404/410 for pages that no longer exist instead of a 200 "not found" page.',
  redirectChain: 'Point links and redirects straight at the final URL.',
  blockedByRobots: 'Unblock the URL in robots.txt or stop linking to it internally.',
  noindexJsInjected: 'Put noindex in the served HTML or X-Robots-Tag; Google may index before rendering.',
  titleChangedByJs: 'Serve the final <title> in the HTML instead of rewriting it with JavaScript.',
  h1ChangedByJs: 'Serve the final <h1> in the HTML instead of writing or rewriting it with JavaScript.',
  canonicalChangedByJs: 'Serve the canonical link in the HTML; a canonical set by JavaScript may be missed before rendering.',
  linksChangedByJs: 'Put internal links in the served HTML so crawlers find them without rendering.',
  textChangedByJs: 'Serve the main text in the HTML; content that appears only after rendering is indexed later, or missed.',
  consoleErrors: 'Fix the scripts that throw or log errors while the page renders; a broken script can hide content from users and crawlers.',
  failedResources: 'Fix or remove the scripts, styles, images and API calls that fail to load; the page renders without them.',
  markupErrors: 'Fix the broken markup (missing doctype, broken or unclosed tags, bad character references, obsolete elements); browsers repair it differently and a parser may read the page another way.',
  duplicateIds: 'Give every id attribute one element: anchors, labels and scripts that look an id up find the wrong element.',
  ampValidationErrors: 'Fix AMP validation errors or the AMP version will not be served.',
  ampTargetBroken: 'Point rel=amphtml at a working AMP page, or remove it.',
  ampTargetRedirect: 'Point rel=amphtml at the final AMP URL, not one that redirects.',
  nonIndexableInSitemap: 'Remove noindex / canonicalised URLs from the XML sitemap.',
  non200InSitemap: 'Remove error and redirecting URLs from the XML sitemap.',
  redirectInSitemap: 'List final URLs in the sitemap, not redirecting ones.',
  crawledNotInSitemap: 'Add indexable pages missing from the sitemap so they are discovered promptly.',
  brokenLinksInternal: 'Fix or remove internal links to 4xx/5xx pages.',
  brokenLinksExternal: 'Update or remove external links to dead pages.',
  brokenBookmark: 'Add the missing id (or <a name>) to the target element, or fix the #fragment in the link.',
  linkEmptyAnchor: 'Give links descriptive anchor text (or alt text on image links).',
  insecureFormAction: 'Submit forms over HTTPS; an HTTP action leaks form data.',
  missingSri: 'Add integrity attributes to third-party scripts and stylesheets.',
  cookieNoSecure: 'Set the Secure flag on cookies served over HTTPS.',
  cookieNoHttpOnly: 'Set HttpOnly on session cookies so scripts cannot read them.',
  cookieNoSameSite: 'Set SameSite on cookies to limit cross-site requests.',
  folderDepthTooDeep: 'Flatten deep folder structures so important pages sit closer to the root.',
  http2NotSupported: 'Enable HTTP/2 (or HTTP/3) on the server for multiplexed, faster page loads.',
  renderBlocking: 'Defer or async non-critical scripts and inline critical CSS to unblock rendering.',
  keepaliveDisabled: 'Enable HTTP keep-alive so browsers reuse connections.',
  highBoilerplate: 'Increase unique main content relative to navigation and footer boilerplate.',
  contentAreaNotFound: 'Widen the content-area selector (Settings → Duplicates) so it also matches these page layouts; until then they are left out of near-duplicate checks.',
};
const SEVERITY_FALLBACK: Record<IssueDef['severity'], string> = {
  error: 'Fix these pages first — this check marks a problem that blocks indexing or breaks the user experience.',
  warn: 'Review and correct where practical; this weakens rankings or usability without blocking them.',
  info: 'Informational — worth tidying when the affected template is next touched.',
};

/** Report severity word of one check, when the report lists it (used by the issue task builder). */
export function issueReportSeverity(key: string): IssueDef['severity'] | undefined {
  return ISSUES.find((d) => d.key === key)?.severity;
}

/** Hand-written fix advice of one check (raw, with `{{…}}` placeholders), if any. */
export function issueAdvice(key: string): string | undefined {
  return (RECOMMENDATIONS as Record<string, string | undefined>)[key];
}

/** Why-it-matters line per report severity (used by the issue task builder). */
export function severityFallback(severity: IssueDef['severity']): string {
  return SEVERITY_FALLBACK[severity];
}

function renderRecommendations(counts: OverviewCounts): string {
  const rows = ISSUES.map((d) => ({
    ...d,
    label: fillThresholdLabel(d.label, counts.thresholds),
    count: counts.issues[d.key] as number,
  }))
    .filter((r) => r.count > 0)
    .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.count - a.count)
    .slice(0, 12);
  if (rows.length === 0) return '<p class="muted">Nothing to recommend — no issues were detected.</p>';
  const items = rows
    .map(
      (r) =>
        `<li><span class="sev-${r.severity}">${escape(r.label)}</span> <span class="muted">(${fmtNum(r.count)} URL${r.count === 1 ? '' : 's'})</span><br>${escape(
          fillThresholdLabel(
            RECOMMENDATIONS[r.key] ?? SEVERITY_FALLBACK[r.severity],
            counts.thresholds,
          ),
        )}</li>`,
    )
    .join('');
  return `<ol class="recs">${items}</ol>`;
}

function renderHeader(options: HtmlReportOptions, generatedAt: Date): string {
  const b = options.branding ?? {};
  const brand = (b.brandName ?? '').trim();
  const logo = b.logoDataUrl && /^data:image\//.test(b.logoDataUrl)
    ? `<img class="logo" src="${b.logoDataUrl}" alt="" />`
    : '';
  const title = brand ? `${escape(brand)} — SEO Report` : 'FreeCrawl SEO Report';
  const preparedBy = (b.preparedBy ?? '').trim();
  return (
    `<header class="hdr">${logo}<div><h1>${title}</h1>` +
    `<div class="muted">Site: <span class="mono">${escape(options.startUrl)}</span> · Generated: ${escape(generatedAt.toISOString())}` +
    (preparedBy ? ` · Prepared by: ${escape(preparedBy)}` : '') +
    `</div></div></header>`
  );
}

function accentStyle(options: HtmlReportOptions): string {
  const raw = (options.branding?.accentColor ?? '').trim();
  const ok = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(raw);
  return ok ? `:root{--accent:${raw}}` : '';
}

/** Site-wide findings that belong to no single URL (shown above the issue table). */
function renderSiteNotices(counts: OverviewCounts): string {
  let out = '';
  const blocked = counts.site?.botBlocked;
  if (blocked) {
    out +=
      `<p><span class="sev-warn">WARN</span> Bot protection blocked ${fmtNum(blocked.count)} ` +
      `URL${blocked.count === 1 ? '' : 's'}` +
      (blocked.sample ? ` (<span class="mono">${escape(blocked.sample)}</span>)` : '') +
      `: they were not crawled, so this report has no data on them and leaves them out of the ` +
      `broken-link and sitemap checks. Lower the crawl speed or allowlist the crawler, then re-crawl.</p>`;
  }
  const sitemaps = counts.site?.sitemapFindings;
  const listFiles = (files: { url: string }[]) =>
    files.map((f) => `<span class="mono">${escape(f.url)}</span>`).join(', ');
  if (sitemaps?.overUrls.length) {
    out +=
      `<p><span class="sev-warn">WARN</span> Sitemap over 50,000 URLs: ${listFiles(sitemaps.overUrls)}. ` +
      `Search engines read at most 50,000 URLs per sitemap file — split it and list the parts in a sitemap index.</p>`;
  }
  if (sitemaps?.overSize.length) {
    out +=
      `<p><span class="sev-warn">WARN</span> Sitemap over 50 MB: ${listFiles(sitemaps.overSize)}. ` +
      `Search engines read at most 50 MB uncompressed per sitemap file — split it and list the parts in a sitemap index.</p>`;
  }
  if (sitemaps?.duplicateEntries.length) {
    out +=
      `<p><span class="sev-warn">WARN</span> Sitemap lists a URL twice: ${listFiles(sitemaps.duplicateEntries)}. ` +
      `Each URL should appear once per sitemap file.</p>`;
  }
  if (sitemaps?.inSeveral.count) {
    const more = sitemaps.inSeveral.count - sitemaps.inSeveral.sample.length;
    out +=
      `<p><span class="sev-info">INFO</span> ${fmtNum(sitemaps.inSeveral.count)} ` +
      `URL${sitemaps.inSeveral.count === 1 ? ' is' : 's are'} in several sitemap files: ` +
      `${listFiles(sitemaps.inSeveral.sample.map((url) => ({ url })))}${more > 0 ? ` and ${fmtNum(more)} more` : ''}. ` +
      `Not necessarily a problem.</p>`;
  }
  const probe = counts.site?.soft404Probe;
  if (!probe) return out;
  const via = probe.finalUrl
    ? ` after redirecting to <span class="mono">${escape(probe.finalUrl)}</span>`
    : '';
  return (
    out +
    `<p><span class="sev-warn">WARN</span> Missing pages return ${probe.status}: ` +
    `<span class="mono">${escape(probe.url)}</span>, a page that does not exist, was answered ` +
    `${probe.status}${via} instead of 404. Broken links on this site look like working pages ` +
    `to search engines (soft 404) — return a real 404 or 410 for missing URLs.</p>`
  );
}

function renderIssues(counts: OverviewCounts): string {
  const notices = renderSiteNotices(counts);
  const rows = ISSUES.map((d) => {
    const c = counts.issues[d.key] as number;
    return { ...d, label: fillThresholdLabel(d.label, counts.thresholds), count: c };
  })
    .filter((r) => r.count > 0)
    .sort((a, b) =>
      SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.count - a.count,
    );
  if (rows.length === 0) {
    return notices || '<p class="muted">No issues detected. Nice.</p>';
  }
  const body = rows
    .map(
      (r) => `<tr>
        <td><span class="sev-${r.severity === 'warn' ? 'warn' : r.severity === 'error' ? 'error' : 'info'}">${r.severity.toUpperCase()}</span></td>
        <td>${escape(r.label)}</td>
        <td class="right mono">${fmtNum(r.count)}</td>
      </tr>`,
    )
    .join('');
  return `${notices}<table><thead><tr><th>Severity</th><th>Issue</th><th class="right">URLs</th></tr></thead><tbody>${body}</tbody></table>`;
}

export async function exportHtmlReport(
  db: ProjectDb,
  filePath: string,
  options: HtmlReportOptions,
): Promise<{ filePath: string; bytesWritten: number }> {
  let bytesWritten = 0;
  const counter = new (await import('node:stream')).Transform({
    transform(chunk, _enc, cb) {
      bytesWritten += chunk.length;
      cb(null, chunk);
    },
  });
  // `.part` + rename: an interrupted export never leaves a truncated report.
  await writeExportFile(filePath, (partPath) =>
    pipeline(
      Readable.from(htmlReportChunks(db, options)),
      counter,
      createWriteStream(partPath, { encoding: 'utf8' }),
    ),
  );
  return { filePath, bytesWritten };
}

/** The whole report as one string — what the PDF export hands to Chromium. */
export async function renderHtmlReport(db: ProjectDb, options: HtmlReportOptions): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of htmlReportChunks(db, options)) parts.push(chunk);
  return parts.join('');
}

async function* htmlReportChunks(
  db: ProjectDb,
  options: HtmlReportOptions,
): AsyncGenerator<string> {
  const summary: CrawlSummary = db.getSummary();
  const counts: OverviewCounts = db.getOverviewCounts();
  const generatedAt = options.generatedAt ?? new Date();

  // Sample tables — three small SELECTs straight out of the URL table.
  // Capped at 25 rows each to keep the report scannable; the live UI is
  // the right place for the full data set.
  const slowestRows = db.topUrlsBy('response_time_ms', 25);
  const deepestRows = db.topUrlsBy('depth', 25);
  const fanoutRows = db.topUrlsBy('outlinks', 25);

  function rowsTable(
    label: string,
    rows: { url: string; value: number | null }[],
    valueLabel: string,
  ): string {
    if (rows.length === 0) return `<p class="muted">No data — ${escape(label)}.</p>`;
    const body = rows
      .map(
        (r) =>
          `<tr><td class="mono">${escape(r.url)}</td><td class="right mono">${escape(
            r.value === null ? '—' : String(r.value),
          )}</td></tr>`,
      )
      .join('');
    return `<table><thead><tr><th>URL</th><th class="right">${escape(valueLabel)}</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  const gen = async function* (): AsyncGenerator<string> {
    const brand = (options.branding?.brandName ?? '').trim();
    yield `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${escape(brand || 'FreeCrawl')} SEO Report — ${escape(options.startUrl)}</title><style>${STYLE}${accentStyle(options)}</style></head><body>`;
    yield renderHeader(options, generatedAt);

    yield `<div class="grid">
      <div class="card"><div class="label">URLs Crawled</div><div class="value">${fmtNum(summary.total)}</div></div>
      <div class="card"><div class="label">Indexable</div><div class="value">${fmtNum(summary.byIndexability['indexable'] ?? 0)}</div></div>
      <div class="card"><div class="label">Avg Response (ms)</div><div class="value">${fmtNum(Math.round(summary.avgResponseTimeMs))}</div></div>
      <div class="card"><div class="label">Total Bytes</div><div class="value">${fmtNum(summary.totalBytes)}</div></div>
    </div>`;

    yield `<section><h2>Issues</h2>${renderIssues(counts)}</section>`;
    yield `<section><h2>Recommendations</h2>${renderRecommendations(counts)}</section>`;
    yield `<section><h2>Top 25 Slowest URLs</h2>${rowsTable('slowest', slowestRows, 'ms')}</section>`;
    yield `<section><h2>Top 25 Deepest URLs</h2>${rowsTable('deepest', deepestRows, 'depth')}</section>`;
    yield `<section><h2>Top 25 Outlink-Heavy URLs</h2>${rowsTable('fanout', fanoutRows, 'outlinks')}</section>`;
    yield `</body></html>`;
  };
  yield* gen();
}
