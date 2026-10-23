import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store.js';
import { SerpCheckPanel } from './SerpCheckPanel.js';
import type {
  PagesPerDirectoryRow,
  StatusCodeHistogramRow,
  IndexabilityDistributionRow,
  ContentKindDistributionRow,
  DepthHistogramRow,
  ResponseTimeHistogramRow,
  TopUrlsRow,
  TopUrlMetric,
  ExternalDomainHealthRow,
  AnalyticsCoverageRow,
  LinkPositionRow,
  ImageWeightRow,
  BucketHistogramRow,
  ServerHeaderRow,
  TopWordsRow,
  WordCountPerDirectoryRow,
  SitemapOrphanRow,
  OrphanCrossSourceRow,
  LinkTargetReportKind,
  LinkTargetRow,
  TemplateLinkFilter,
} from '@freecrawl/shared-types';
import { cloudSizes } from '@freecrawl/shared-types';

interface Props {
  open: boolean;
  /** Report to show on opening, e.g. from a sidebar entry (B76). */
  initialKind?: string | null;
  onClose: () => void;
}

type ReportKind =
  | 'pages-per-dir'
  | 'status-codes'
  | 'indexability-distribution'
  | 'content-kind-distribution'
  | 'depth'
  | 'response-time'
  | 'slowest-urls'
  | 'most-inlinks'
  | 'least-inlinks'
  | 'most-outlinks'
  | 'biggest-pages'
  | 'deepest-urls'
  | 'external-domain-health'
  | 'analytics-coverage'
  | 'link-positions'
  | LinkTargetReportKind
  | 'image-weight'
  | 'inlinks-histogram'
  | 'word-count-histogram'
  | 'url-length-histogram'
  | 'word-count-per-dir'
  | 'sitemap-orphans'
  | 'orphan-cross-source'
  | 'server-headers'
  | 'top-words'
  | 'serp-check'
  | 'pages-over-link-limit'
  | 'mobile-parity';

interface ReportRow {
  /** Unique React key when `key` repeats (the same phrase in two sections). */
  id?: string;
  /** Display key (directory path / status code / depth label). */
  key: string;
  /** Optional column shown left-of-key (e.g. status-class label). */
  badge?: string;
  count: number;
  /**
   * Optional secondary numeric value (response time ms, page bytes, etc.).
   * When present, rows render `count` as the bar metric and `valueLabel`
   * as a separate "Value" column.
   */
  valueLabel?: string;
  /** Optional muted second line under the key (a sample linking page). */
  detail?: string;
}

/** The link reports grouped by target; each row is one linked URL. */
const LINK_TARGET_KINDS: ReadonlySet<ReportKind> = new Set<LinkTargetReportKind>([
  'redirect-inlinks',
  'redirects-to-error',
  'error-inlinks',
  'non-indexable-inlinks',
]);

const REPORT_LABELS: Record<ReportKind, string> = {
  'pages-per-dir': 'Pages per Directory',
  'status-codes': 'Status Code Histogram',
  'indexability-distribution': 'Indexability Distribution',
  'content-kind-distribution': 'Content-Type Distribution',
  depth: 'Depth Histogram',
  'response-time': 'Response Time Histogram',
  'slowest-urls': 'Slowest URLs (Top 25)',
  'most-inlinks': 'Most-Linked URLs (Top 25)',
  'least-inlinks': 'Least-Linked URLs (Bottom 25, indexable HTML)',
  'most-outlinks': 'Most-Outlinking URLs (Top 25)',
  'biggest-pages': 'Biggest Pages (Top 25)',
  'deepest-urls': 'Deepest URLs (Top 25)',
  'external-domain-health': 'External Domain Health',
  'analytics-coverage': 'Analytics Tracker Coverage',
  'link-positions': 'Internal Link Positions',
  'redirect-inlinks': 'Links to Redirects (by Target)',
  'redirects-to-error': 'Redirects to Error (by Target)',
  'error-inlinks': 'Links to Error Pages (by Target)',
  'non-indexable-inlinks': 'Links to Non-Indexable Pages (by Target)',
  'image-weight': 'Image Weight per Page (Top 25)',
  'inlinks-histogram': 'Inlinks Histogram',
  'word-count-histogram': 'Word Count Histogram',
  'url-length-histogram': 'URL Length Histogram',
  'word-count-per-dir': 'Word Count per Directory',
  'sitemap-orphans': 'Sitemap Orphans (Top 1000)',
  'orphan-cross-source': 'Orphan Pages — Sitemap + GSC + GA4 + Metrica (Top 1000)',
  'server-headers': 'Server Stack (Server Header)',
  'top-words': 'Top Words (Title + Meta + H1, Top 100)',
  'serp-check': 'SERP check',
  'pages-over-link-limit': 'Pages Over Max Links per Page',
  'mobile-parity': 'Mobile vs Desktop Differences',
};

const TOP_URL_METRIC: Record<ReportKind, TopUrlMetric | null> = {
  'pages-per-dir': null,
  'status-codes': null,
  'indexability-distribution': null,
  'content-kind-distribution': null,
  depth: null,
  'response-time': null,
  'slowest-urls': 'response-time',
  'most-inlinks': 'inlinks',
  'least-inlinks': 'inlinks',
  'most-outlinks': 'outlinks',
  'biggest-pages': 'page-size',
  'deepest-urls': 'depth',
  'external-domain-health': null,
  'analytics-coverage': null,
  'link-positions': null,
  'redirect-inlinks': null,
  'redirects-to-error': null,
  'error-inlinks': null,
  'non-indexable-inlinks': null,
  'image-weight': null,
  'inlinks-histogram': null,
  'word-count-histogram': null,
  'url-length-histogram': null,
  'word-count-per-dir': null,
  'sitemap-orphans': null,
  'orphan-cross-source': null,
  'server-headers': null,
  'top-words': null,
  'serp-check': null,
  'pages-over-link-limit': null,
  'mobile-parity': null,
};

const VALUE_FORMAT: Record<ReportKind, (v: number | null) => string> = {
  'pages-per-dir': (v) => (v ?? 0).toLocaleString(),
  'status-codes': (v) => (v ?? 0).toLocaleString(),
  'indexability-distribution': (v) => (v ?? 0).toLocaleString(),
  'content-kind-distribution': (v) => (v ?? 0).toLocaleString(),
  depth: (v) => (v ?? 0).toLocaleString(),
  'response-time': (v) => (v ?? 0).toLocaleString(),
  'slowest-urls': (v) => (v == null ? '—' : `${v.toLocaleString()} ms`),
  'most-inlinks': (v) => (v ?? 0).toLocaleString(),
  'least-inlinks': (v) => (v ?? 0).toLocaleString(),
  'most-outlinks': (v) => (v ?? 0).toLocaleString(),
  'biggest-pages': (v) => (v == null ? '—' : `${(v / 1024).toFixed(1)} KB`),
  'deepest-urls': (v) => (v ?? 0).toLocaleString(),
  'external-domain-health': (v) => (v ?? 0).toLocaleString(),
  'analytics-coverage': (v) => (v ?? 0).toLocaleString(),
  'link-positions': (v) => (v ?? 0).toLocaleString(),
  'redirect-inlinks': (v) => (v ?? 0).toLocaleString(),
  'redirects-to-error': (v) => (v ?? 0).toLocaleString(),
  'error-inlinks': (v) => (v ?? 0).toLocaleString(),
  'non-indexable-inlinks': (v) => (v ?? 0).toLocaleString(),
  'image-weight': (v) => {
    if (v == null) return '—';
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1024 / 1024).toFixed(2)} MB`;
  },
  'inlinks-histogram': (v) => (v ?? 0).toLocaleString(),
  'word-count-histogram': (v) => (v ?? 0).toLocaleString(),
  'url-length-histogram': (v) => (v ?? 0).toLocaleString(),
  'word-count-per-dir': (v) => (v ?? 0).toLocaleString(),
  'sitemap-orphans': (v) => (v ?? 0).toLocaleString(),
  'orphan-cross-source': (v) => (v ?? 0).toLocaleString(),
  'server-headers': (v) => (v ?? 0).toLocaleString(),
  'top-words': (v) => (v ?? 0).toLocaleString(),
  'serp-check': () => '',
  'pages-over-link-limit': (v) => (v ?? 0).toLocaleString(),
  'mobile-parity': (v) => (v ?? 0).toLocaleString(),
};

export function ReportsDialog({ open, initialKind, onClose }: Props) {
  const { t } = useTranslation();
  const maxLinksPerPage = useAppStore((s) => s.config.maxLinksPerPage);
  const [kind, setKind] = useState<ReportKind>('pages-per-dir');
  const [depth, setDepth] = useState(1);
  const [includeBody, setIncludeBody] = useState(false);
  // Top Words (B84): words or phrases, whole site or by section, list or cloud.
  const [topN, setTopN] = useState<1 | 2 | 3>(1);
  const [topLocale, setTopLocale] = useState<'all' | 'en' | 'ru' | 'tr'>('all');
  const [topBySection, setTopBySection] = useState(false);
  /** '' = every section. */
  const [topSection, setTopSection] = useState('');
  const [topSections, setTopSections] = useState<string[]>([]);
  const [topView, setTopView] = useState<'list' | 'cloud'>('list');
  const [topCapped, setTopCapped] = useState(false);
  const [templateLinks, setTemplateLinks] = useState<TemplateLinkFilter>('include');
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(false);
  /** The report needs a post-crawl pass that has not run (see linkTargetReport). */
  const [notComputed, setNotComputed] = useState(false);
  // Orphan report only: space-separated patterns that hide service URLs.
  // `orphanApplied` bumps on each successful save so the report reloads.
  const [orphanExclude, setOrphanExclude] = useState('');
  const [orphanExcludeError, setOrphanExcludeError] = useState<string | null>(null);
  const [orphanApplied, setOrphanApplied] = useState(0);
  useEffect(() => {
    if (open && initialKind && initialKind in REPORT_LABELS) setKind(initialKind as ReportKind);
  }, [open, initialKind]);

  // Localised label maps. Memoised on `t` so they only rebuild when the
  // language changes, not on every render.
  const reportLabels = useMemo<Record<ReportKind, string>>(() => ({
    'pages-per-dir': t('reports.report.pagesPerDir', { defaultValue: REPORT_LABELS['pages-per-dir'] }),
    'status-codes': t('reports.report.statusCodes', { defaultValue: REPORT_LABELS['status-codes'] }),
    'indexability-distribution': t('reports.report.indexabilityDistribution', { defaultValue: REPORT_LABELS['indexability-distribution'] }),
    'content-kind-distribution': t('reports.report.contentKindDistribution', { defaultValue: REPORT_LABELS['content-kind-distribution'] }),
    depth: t('reports.report.depth', { defaultValue: REPORT_LABELS.depth }),
    'response-time': t('reports.report.responseTime', { defaultValue: REPORT_LABELS['response-time'] }),
    'slowest-urls': t('reports.report.slowestUrls', { defaultValue: REPORT_LABELS['slowest-urls'] }),
    'most-inlinks': t('reports.report.mostInlinks', { defaultValue: REPORT_LABELS['most-inlinks'] }),
    'least-inlinks': t('reports.report.leastInlinks', { defaultValue: REPORT_LABELS['least-inlinks'] }),
    'most-outlinks': t('reports.report.mostOutlinks', { defaultValue: REPORT_LABELS['most-outlinks'] }),
    'biggest-pages': t('reports.report.biggestPages', { defaultValue: REPORT_LABELS['biggest-pages'] }),
    'deepest-urls': t('reports.report.deepestUrls', { defaultValue: REPORT_LABELS['deepest-urls'] }),
    'external-domain-health': t('reports.report.externalDomainHealth', { defaultValue: REPORT_LABELS['external-domain-health'] }),
    'analytics-coverage': t('reports.report.analyticsCoverage', { defaultValue: REPORT_LABELS['analytics-coverage'] }),
    'link-positions': t('reports.report.linkPositions', { defaultValue: REPORT_LABELS['link-positions'] }),
    'redirect-inlinks': t('reports.report.redirectInlinks', { defaultValue: REPORT_LABELS['redirect-inlinks'] }),
    'redirects-to-error': t('reports.report.redirectsToError', { defaultValue: REPORT_LABELS['redirects-to-error'] }),
    'error-inlinks': t('reports.report.errorInlinks', { defaultValue: REPORT_LABELS['error-inlinks'] }),
    'non-indexable-inlinks': t('reports.report.nonIndexableInlinks', {
      defaultValue: REPORT_LABELS['non-indexable-inlinks'],
    }),
    'image-weight': t('reports.report.imageWeight', { defaultValue: REPORT_LABELS['image-weight'] }),
    'inlinks-histogram': t('reports.report.inlinksHistogram', { defaultValue: REPORT_LABELS['inlinks-histogram'] }),
    'word-count-histogram': t('reports.report.wordCountHistogram', { defaultValue: REPORT_LABELS['word-count-histogram'] }),
    'url-length-histogram': t('reports.report.urlLengthHistogram', { defaultValue: REPORT_LABELS['url-length-histogram'] }),
    'word-count-per-dir': t('reports.report.wordCountPerDir', { defaultValue: REPORT_LABELS['word-count-per-dir'] }),
    'sitemap-orphans': t('reports.report.sitemapOrphans', { defaultValue: REPORT_LABELS['sitemap-orphans'] }),
    'orphan-cross-source': t('reports.report.orphanCrossSource', { defaultValue: REPORT_LABELS['orphan-cross-source'] }),
    'server-headers': t('reports.report.serverHeaders', { defaultValue: REPORT_LABELS['server-headers'] }),
    'top-words': t('reports.report.topWords', { defaultValue: REPORT_LABELS['top-words'] }),
    'serp-check': t('reports.report.serpCheck', { defaultValue: REPORT_LABELS['serp-check'] }),
    'pages-over-link-limit': t('reports.report.pagesOverLinkLimit', {
      defaultValue: REPORT_LABELS['pages-over-link-limit'],
    }),
    'mobile-parity': t('reports.report.mobileParity', { defaultValue: REPORT_LABELS['mobile-parity'] }),
  }), [t]);
  const keyLabels = useMemo<Record<ReportKind, string>>(() => ({
    'pages-per-dir': t('reports.keyDirectory', { defaultValue: 'Directory' }),
    'status-codes': t('reports.keyStatus', { defaultValue: 'Status' }),
    'indexability-distribution': t('reports.keyIndexability', { defaultValue: 'Indexability' }),
    'content-kind-distribution': t('reports.keyContentType', { defaultValue: 'Content Type' }),
    depth: t('reports.keyDepth', { defaultValue: 'Depth' }),
    'response-time': t('reports.keyBucket', { defaultValue: 'Bucket' }),
    'slowest-urls': 'URL',
    'most-inlinks': 'URL',
    'least-inlinks': 'URL',
    'most-outlinks': 'URL',
    'biggest-pages': 'URL',
    'deepest-urls': 'URL',
    'external-domain-health': t('reports.keyDomain', { defaultValue: 'Domain' }),
    'analytics-coverage': t('reports.keyTracker', { defaultValue: 'Tracker' }),
    'link-positions': t('reports.keyPosition', { defaultValue: 'Position' }),
    'redirect-inlinks': t('reports.keyLinkTarget', { defaultValue: 'Link Target' }),
    'redirects-to-error': t('reports.keyLinkTarget', { defaultValue: 'Link Target' }),
    'error-inlinks': t('reports.keyLinkTarget', { defaultValue: 'Link Target' }),
    'non-indexable-inlinks': t('reports.keyLinkTarget', { defaultValue: 'Link Target' }),
    'image-weight': 'URL',
    'inlinks-histogram': t('reports.keyBucket', { defaultValue: 'Bucket' }),
    'word-count-histogram': t('reports.keyBucket', { defaultValue: 'Bucket' }),
    'url-length-histogram': t('reports.keyBucket', { defaultValue: 'Bucket' }),
    'word-count-per-dir': t('reports.keyDirectory', { defaultValue: 'Directory' }),
    'sitemap-orphans': 'URL',
    'orphan-cross-source': 'URL',
    'server-headers': t('reports.keyServer', { defaultValue: 'Server' }),
    'top-words': topN === 1 ? t('reports.keyWord', { defaultValue: 'Word' }) : t('reports.keyPhrase', { defaultValue: 'Phrase' }),
    'serp-check': 'URL',
    'pages-over-link-limit': 'URL',
    'mobile-parity': 'URL',
  }), [t, topN]);

  useEffect(() => {
    if (!open) return;
    if (kind === 'serp-check') {
      // B85: the panel owns its data (pasted text); nothing is read from the project.
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setNotComputed(false);
    const load = async () => {
      try {
        if (kind === 'pages-per-dir') {
          const r = await window.freecrawl.reportsPagesPerDirectory({ depth, limit: 1000 });
          if (!cancelled)
            setRows(r.map((x: PagesPerDirectoryRow) => ({ key: x.directory, count: x.count })));
        } else if (kind === 'status-codes') {
          const r = await window.freecrawl.reportsStatusCodeHistogram();
          if (!cancelled)
            setRows(
              r.map((x: StatusCodeHistogramRow) => ({
                key:
                  x.status === null
                    ? t('reports.noResponse', { defaultValue: 'No response' })
                    : String(x.status),
                badge: statusBadge(x.status, t),
                count: x.count,
              })),
            );
        } else if (kind === 'indexability-distribution') {
          const r = await window.freecrawl.reportsIndexabilityDistribution();
          if (!cancelled)
            setRows(
              r.map((x: IndexabilityDistributionRow) => ({
                key: indexabilityLabel(x.indexability, t),
                badge:
                  x.indexability === 'indexable'
                    ? t('reports.badge.ok', { defaultValue: 'OK' })
                    : t('reports.badge.non', { defaultValue: 'NON' }),
                count: x.count,
              })),
            );
        } else if (kind === 'content-kind-distribution') {
          const r = await window.freecrawl.reportsContentKindDistribution();
          if (!cancelled)
            setRows(
              r.map((x: ContentKindDistributionRow) => ({
                key: contentKindLabel(x.contentKind, t),
                count: x.count,
              })),
            );
        } else if (kind === 'depth') {
          const r = await window.freecrawl.reportsDepthHistogram();
          if (!cancelled)
            setRows(r.map((x: DepthHistogramRow) => ({ key: String(x.depth), count: x.count })));
        } else if (kind === 'response-time') {
          const r = await window.freecrawl.reportsResponseTimeHistogram();
          if (!cancelled)
            setRows(
              r.map((x: ResponseTimeHistogramRow) => ({
                key: bucketLabel(x.label, t),
                badge: rtBadge(x.label, t),
                count: x.count,
              })),
            );
        } else if (kind === 'external-domain-health') {
          const r = await window.freecrawl.reportsExternalDomainHealth(100);
          if (!cancelled)
            setRows(
              r.map((x: ExternalDomainHealthRow) => ({
                key: x.domain,
                badge:
                  x.errorRatePercent === 0
                    ? t('reports.badge.ok', { defaultValue: 'OK' })
                    : x.errorRatePercent < 10
                      ? t('reports.badge.warn', { defaultValue: 'WARN' })
                      : t('reports.badge.bad', { defaultValue: 'BAD' }),
                // Bar = error count so the worst domains spike visually;
                // value label shows the breakdown.
                count: x.errorCount,
                valueLabel:
                  t('reports.domainHealth', {
                    defaultValue: '{{ok}}/{{total}} OK · {{rate}}% errors',
                    ok: x.successCount.toLocaleString(),
                    total: x.totalUrls.toLocaleString(),
                    rate: x.errorRatePercent,
                  }) +
                  (x.avgResponseTimeMs !== null
                    ? ` · ${t('reports.avgMs', { defaultValue: '{{ms}} ms avg', ms: x.avgResponseTimeMs.toLocaleString() })}`
                    : ''),
              })),
            );
        } else if (kind === 'analytics-coverage') {
          const r = await window.freecrawl.reportsAnalyticsCoverage();
          if (!cancelled)
            setRows(
              r.map((x: AnalyticsCoverageRow) => ({
                key: x.name,
                count: x.pageCount,
                valueLabel: [
                  pageCountLabel(x.pageCount, t),
                  t('reports.distinctIds', {
                    defaultValue_one: '{{count}} distinct ID',
                    defaultValue_other: '{{count}} distinct IDs',
                    defaultValue: '{{count}} distinct IDs',
                    count: x.distinctIds,
                  }),
                  ...(x.sampleIds.length > 0 ? [x.sampleIds.join(', ')] : []),
                ].join(' · '),
              })),
            );
        } else if (kind === 'link-positions') {
          const r = await window.freecrawl.reportsLinkPositions();
          if (!cancelled)
            setRows(
              r.map((x: LinkPositionRow) => ({
                key: linkPositionLabel(x.position, t),
                count: x.count,
              })),
            );
        } else if (LINK_TARGET_KINDS.has(kind)) {
          const report = kind as LinkTargetReportKind;
          const r = await window.freecrawl.reportsLinkTargets({ report, templateLinks, limit: 1000 });
          if (cancelled) return;
          if (r === null) {
            setNotComputed(true);
            setRows([]);
          } else
            setRows(
              r.map((x: LinkTargetRow) => ({
                // The redirect end sits next to the target: the pair is the fix.
                key: x.finalUrl
                  ? `${x.targetUrl} → ${x.finalUrl} (${finalStatusText(x, t)})`
                  : x.targetUrl,
                badge: statusBadge(x.statusCode, t),
                // Bar = linking pages, so site-wide targets spike.
                count: x.sourcePages,
                valueLabel: [
                  pageCountLabel(x.sourcePages, t),
                  report === 'non-indexable-inlinks' && x.indexability
                    ? indexabilityLabel(x.indexability, t)
                    : null,
                  x.topPosition ? linkPositionLabel(x.topPosition, t) : null,
                  x.isTemplate ? t('reports.templateLink', { defaultValue: 'template link' }) : null,
                ]
                  .filter(Boolean)
                  .join(' · '),
                ...(x.sampleSourceUrl
                  ? { detail: t('reports.sampleSource', { defaultValue: 'e.g. {{url}}', url: x.sampleSourceUrl }) }
                  : {}),
              })),
            );
        } else if (kind === 'image-weight') {
          const r = await window.freecrawl.reportsImageWeightPerPage(25);
          if (!cancelled)
            setRows(
              r.map((x: ImageWeightRow) => ({
                key: x.url,
                count: x.imageBytes,
                valueLabel: `${VALUE_FORMAT['image-weight'](x.imageBytes)} · ${t('reports.imageCount', {
                  defaultValue_one: '{{formatted}} image',
                  defaultValue_other: '{{formatted}} images',
                  defaultValue: '{{formatted}} images',
                  count: x.imageCount,
                  formatted: x.imageCount.toLocaleString(),
                })}`,
              })),
            );
        } else if (kind === 'inlinks-histogram') {
          const r = await window.freecrawl.reportsInlinksHistogram();
          if (!cancelled)
            setRows(r.map((x: BucketHistogramRow) => ({ key: bucketLabel(x.label, t), count: x.count })));
        } else if (kind === 'word-count-histogram') {
          const r = await window.freecrawl.reportsWordCountHistogram();
          if (!cancelled)
            setRows(r.map((x: BucketHistogramRow) => ({ key: x.label, count: x.count })));
        } else if (kind === 'url-length-histogram') {
          const r = await window.freecrawl.reportsUrlLengthHistogram();
          if (!cancelled)
            setRows(r.map((x: BucketHistogramRow) => ({ key: x.label, count: x.count })));
        } else if (kind === 'word-count-per-dir') {
          const r = await window.freecrawl.reportsWordCountPerDirectory({
            depth,
            limit: 1000,
          });
          if (!cancelled)
            setRows(
              r.map((x: WordCountPerDirectoryRow) => ({
                key: x.directory,
                // Bar metric is the avg word count so the deepest-content
                // directories visually spike; secondary value shows page
                // count so the user can spot single-page outliers.
                count: x.avgWordCount,
                valueLabel: `${t('reports.avgWords', {
                  defaultValue: '{{formatted}} avg',
                  formatted: x.avgWordCount.toLocaleString(),
                })} · ${pageCountLabel(x.pageCount, t)}`,
              })),
            );
        } else if (kind === 'sitemap-orphans') {
          const r = await window.freecrawl.reportsSitemapOrphans(1000);
          if (!cancelled)
            setRows(
              r.map((x: SitemapOrphanRow) => ({
                key: x.url,
                // Constant bar (1) keeps every row visually equal — there
                // is no metric to scale against; the meaning is "this URL
                // is in the sitemap but never crawled". Lastmod + source
                // sitemap go to the secondary value column.
                count: 1,
                valueLabel: [
                  x.lastmod ? t('reports.lastmod', { defaultValue: 'lastmod {{date}}', date: x.lastmod }) : null,
                  x.sourceSitemap
                    ? t('reports.fromSitemap', { defaultValue: 'from {{sitemap}}', sitemap: x.sourceSitemap })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—',
              })),
            );
        } else if (kind === 'orphan-cross-source') {
          const r = await window.freecrawl.reportsOrphanCrossSource(1000);
          if (!cancelled)
            setRows(
              r.map((x: OrphanCrossSourceRow) => ({
                key: x.url,
                count: 1,
                // `sources` (sitemap / gsc / ga4 / metrica) plus any traffic go in the
                // secondary value column so the user can triage why each URL
                // was missed and how much it matters — sitemap-only with no
                // traffic is often a dead entry to drop; GSC clicks / GA4
                // sessions mean real user-visited pages no crawl path reaches.
                valueLabel: [
                  x.sources.join(' + '),
                  x.gscClicks != null
                    ? t('reports.orphanGscClicks', {
                        defaultValue_one: '{{formatted}} GSC click',
                        defaultValue_other: '{{formatted}} GSC clicks',
                        defaultValue: '{{formatted}} GSC clicks',
                        count: x.gscClicks,
                        formatted: x.gscClicks.toLocaleString(),
                      })
                    : null,
                  x.gscImpressions != null
                    ? t('reports.orphanGscImpressions', {
                        defaultValue_one: '{{formatted}} impr',
                        defaultValue_other: '{{formatted}} impr',
                        defaultValue: '{{formatted}} impr',
                        count: x.gscImpressions,
                        formatted: x.gscImpressions.toLocaleString(),
                      })
                    : null,
                  x.ga4Sessions != null
                    ? t('reports.orphanGa4Sessions', {
                        defaultValue_one: '{{formatted}} GA4 session',
                        defaultValue_other: '{{formatted}} GA4 sessions',
                        defaultValue: '{{formatted}} GA4 sessions',
                        count: x.ga4Sessions,
                        formatted: x.ga4Sessions.toLocaleString(),
                      })
                    : null,
                  x.metricaVisits != null
                    ? t('reports.orphanMetricaVisits', {
                        defaultValue_one: '{{formatted}} Metrica visit (landing)',
                        defaultValue_other: '{{formatted}} Metrica visits (landing)',
                        defaultValue: '{{formatted}} Metrica visits (landing)',
                        count: x.metricaVisits,
                        formatted: x.metricaVisits.toLocaleString(),
                      })
                    : null,
                  x.metricaPageviews != null
                    ? t('reports.orphanMetricaPageviews', {
                        defaultValue_one: '{{formatted}} Metrica pageview (hits)',
                        defaultValue_other: '{{formatted}} Metrica pageviews (hits)',
                        defaultValue: '{{formatted}} Metrica pageviews (hits)',
                        count: x.metricaPageviews,
                        formatted: x.metricaPageviews.toLocaleString(),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · '),
              })),
            );
        } else if (kind === 'server-headers') {
          const r = await window.freecrawl.reportsServerHeaders();
          if (!cancelled)
            setRows(r.map((x: ServerHeaderRow) => ({ key: x.server, count: x.count })));
        } else if (kind === 'top-words') {
          const blocks = await window.freecrawl.reportsTopWordsBlocks({
            limit: 100,
            minLength: 3,
            includeBody,
            n: topN,
            locale: topLocale,
            bySection: topBySection && topSection === '',
            ...(topBySection && topSection !== '' ? { section: topSection } : {}),
          });
          if (!cancelled) {
            setTopCapped(blocks.some((b) => b.capped));
            if (topBySection && topSection === '') setTopSections(blocks.map((b) => b.section));
          }
          const r = blocks.flatMap((b) =>
            b.rows.map((x: TopWordsRow) => ({ ...x, section: b.scope === 'site' ? '' : b.section })),
          );
          if (!cancelled)
            setRows(
              r.map((x: TopWordsRow & { section: string }) => ({
                key: x.word,
                id: `${x.section}\u0000${x.word}`,
                badge: x.section || undefined,
                // Bar metric is total occurrence count so the loudest
                // terms spike visually. Page-coverage is shown beside it
                // so the user can spot "high count, narrow coverage" =
                // a single page repeating a word.
                count: x.count,
                valueLabel: `${t('reports.hits', {
                  defaultValue_one: '{{formatted}} hit',
                  defaultValue_other: '{{formatted}} hits',
                  defaultValue: '{{formatted}} hits',
                  count: x.count,
                  formatted: x.count.toLocaleString(),
                })} · ${pageCountLabel(x.pages, t)}`,
              })),
            );
        } else if (kind === 'mobile-parity') {
          const r = await window.freecrawl.reportsMobileParity(500);
          if (!cancelled)
            setRows(
              r.map((x: TopUrlsRow) => ({
                key: x.url,
                count: x.value ?? 0,
                valueLabel: VALUE_FORMAT[kind](x.value),
              })),
            );
        } else if (kind === 'pages-over-link-limit') {
          // Threshold follows Settings → Advanced → Max links per page;
          // 0 ("disabled") falls back to the sidebar's 100-link check.
          const threshold = maxLinksPerPage > 0 ? maxLinksPerPage : 100;
          const r = await window.freecrawl.reportsPagesOverLinkLimit({ threshold, limit: 500 });
          if (!cancelled)
            setRows(
              r.map((x: TopUrlsRow) => ({
                key: x.url,
                count: x.value ?? 0,
                valueLabel: VALUE_FORMAT[kind](x.value),
              })),
            );
        } else {
          const metric = TOP_URL_METRIC[kind];
          if (metric) {
            const direction = kind === 'least-inlinks' ? 'asc' : 'desc';
            const r = await window.freecrawl.reportsTopUrls({
              metric,
              limit: 25,
              direction,
            });
            if (!cancelled)
              setRows(
                r.map((x: TopUrlsRow) => ({
                  key: x.url,
                  // Bar metric is the value itself (response time, inlinks, etc.).
                  count: x.value ?? 0,
                  valueLabel: VALUE_FORMAT[kind](x.value),
                })),
              );
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, kind, depth, maxLinksPerPage, includeBody, topN, topLocale, topBySection, topSection, orphanApplied, templateLinks, t]);

  useEffect(() => {
    if (!open) return;
    void window.freecrawl
      .reportsOrphanExcludeGet()
      .then((list) => setOrphanExclude(list.join(' ')));
  }, [open]);

  const applyOrphanExclude = async () => {
    const res = await window.freecrawl.reportsOrphanExcludeSet(
      orphanExclude.split(/\s+/).filter(Boolean),
    );
    setOrphanExcludeError(res.error);
    if (!res.error) setOrphanApplied((n) => n + 1);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Reports fetch up to 1000 rows (pages-per-dir, orphans, …); rendering them
  // all as <tr> inside a modal is a visible jank hit and violates the >500-row
  // rule (CLAUDE.md 4.5). Virtualize with dynamic measurement because the key
  // column wraps (break-all on long URLs / paths), so rows aren't fixed-height.
  // Declared BEFORE the `!open` early return so the hook order stays stable.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 15,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  if (!open) return null;

  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-[760px] flex-col rounded-md border border-surface-700 bg-surface-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center border-b border-surface-800 px-4 py-2.5">
          <div className="text-sm font-semibold tracking-wide text-surface-100">
            {reportLabels[kind]}
          </div>
          <button
            className="ml-auto rounded p-1 text-surface-400 hover:bg-surface-800 hover:text-surface-100"
            onClick={onClose}
            title={t('scheduled.closeEsc', { defaultValue: 'Close (Esc)' })}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-surface-800 bg-surface-900/50 px-4 py-2 text-[11px]">
          <label className="flex items-center gap-1.5">
            <span className="text-surface-400">{t('reports.reportLabel', { defaultValue: 'Report' })}</span>
            <select
              className="rounded border border-surface-700 bg-surface-950 px-2 py-0.5 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none"
              value={kind}
              onChange={(e) => setKind(e.target.value as ReportKind)}
            >
              {(Object.keys(reportLabels) as ReportKind[]).map((k) => (
                <option key={k} value={k}>{reportLabels[k]}</option>
              ))}
            </select>
          </label>
          {kind === 'top-words' && (
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={includeBody}
                onChange={(e) => setIncludeBody(e.target.checked)}
                className="h-3.5 w-3.5 accent-blue-500"
              />
              <span className="text-surface-400">
                {t('reports.includeBody', { defaultValue: 'Include body text (slower)' })}
              </span>
            </label>
          )}
          {kind === 'top-words' && (
            <>
              <label className="flex items-center gap-1.5" title={t('reports.ngrams', { defaultValue: 'N-grams' })}>
                <span className="text-surface-400">{t('reports.wordsPhrases', { defaultValue: 'Words / Phrases' })}</span>
                <select
                  className="rounded border border-surface-700 bg-surface-950 px-2 py-0.5 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none"
                  value={topN}
                  onChange={(e) => setTopN(Number.parseInt(e.target.value, 10) as 1 | 2 | 3)}
                >
                  <option value={1}>{t('reports.ngramWords', { defaultValue: 'Words' })}</option>
                  <option value={2}>{t('reports.ngramPhrases2', { defaultValue: '2-word phrases' })}</option>
                  <option value={3}>{t('reports.ngramPhrases3', { defaultValue: '3-word phrases' })}</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-surface-400">{t('reports.stopLocale', { defaultValue: 'Language of stop words' })}</span>
                <select
                  className="rounded border border-surface-700 bg-surface-950 px-2 py-0.5 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none"
                  value={topLocale}
                  onChange={(e) => setTopLocale(e.target.value as 'all' | 'en' | 'ru' | 'tr')}
                >
                  <option value="all">{t('reports.stopLocaleAll', { defaultValue: 'All' })}</option>
                  <option value="en">{t('reports.stopLocaleEn', { defaultValue: 'English' })}</option>
                  <option value="ru">{t('reports.stopLocaleRu', { defaultValue: 'Russian' })}</option>
                  <option value="tr">{t('reports.stopLocaleTr', { defaultValue: 'Turkish' })}</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-surface-400">{t('reports.section', { defaultValue: 'Section' })}</span>
                <select
                  className="rounded border border-surface-700 bg-surface-950 px-2 py-0.5 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none"
                  value={topBySection ? (topSection === '' ? '*' : topSection) : ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTopBySection(v !== '');
                    setTopSection(v === '*' || v === '' ? '' : v);
                  }}
                >
                  <option value="">{t('reports.wholeSite', { defaultValue: 'Whole site' })}</option>
                  <option value="*">{t('reports.allSections', { defaultValue: 'All sections' })}</option>
                  {topSections.filter((x) => x !== '(other)').map((x) => (
                    <option key={x} value={x}>{x}</option>
                  ))}
                </select>
              </label>
              <span className="flex items-center gap-1">
                {(['list', 'cloud'] as const).map((v) => (
                  <button
                    key={v}
                    className={`rounded border px-2 py-0.5 ${topView === v ? 'border-blue-500 text-surface-100' : 'border-surface-700 text-surface-400 hover:bg-surface-800'}`}
                    onClick={() => setTopView(v)}
                  >
                    {v === 'list' ? t('reports.viewList', { defaultValue: 'List' }) : t('reports.viewCloud', { defaultValue: 'Cloud' })}
                  </button>
                ))}
              </span>
              {topCapped && (
                <span className="text-amber-400">
                  {t('reports.topWordsCapped', { defaultValue: 'Approximate: rare phrases were dropped to stay within memory.' })}
                </span>
              )}
            </>
          )}
          {kind === 'orphan-cross-source' && (
            <label className="flex items-center gap-1.5">
              <span className="text-surface-400">
                {t('reports.orphanExclude', { defaultValue: 'Hide URLs matching (regex, space-separated)' })}
              </span>
              <input
                className="w-48 rounded border border-surface-700 bg-surface-950 px-2 py-0.5 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none"
                value={orphanExclude}
                placeholder="/a/ ^https://x\.com/tmp/"
                onChange={(e) => setOrphanExclude(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void applyOrphanExclude();
                }}
              />
              <button
                className="rounded border border-surface-700 px-2 py-0.5 text-surface-100 hover:bg-surface-800"
                onClick={() => void applyOrphanExclude()}
              >
                {t('common.apply', { defaultValue: 'Apply' })}
              </button>
              {orphanExcludeError && <span className="text-red-400">{orphanExcludeError}</span>}
            </label>
          )}
          {LINK_TARGET_KINDS.has(kind) && (
            <label
              className="flex items-center gap-1.5"
              title={t('reports.templateLinksHint', {
                defaultValue: 'Linked from at least 80% of internal HTML pages: menus, headers, footers',
              })}
            >
              <span className="text-surface-400">{t('reports.templateLinks', { defaultValue: 'Template links' })}</span>
              <select
                className="rounded border border-surface-700 bg-surface-950 px-2 py-0.5 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none"
                value={templateLinks}
                onChange={(e) => setTemplateLinks(e.target.value as TemplateLinkFilter)}
              >
                <option value="include">{t('reports.templateInclude', { defaultValue: 'Show' })}</option>
                <option value="exclude">{t('reports.templateExclude', { defaultValue: 'Hide' })}</option>
                <option value="only">{t('reports.templateOnly', { defaultValue: 'Only these' })}</option>
              </select>
            </label>
          )}
          {(kind === 'pages-per-dir' || kind === 'word-count-per-dir') && (
            <label className="flex items-center gap-1.5">
              <span className="text-surface-400">{t('reports.groupAtDepth', { defaultValue: 'Group at depth' })}</span>
              <select
                className="rounded border border-surface-700 bg-surface-950 px-2 py-0.5 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none"
                value={depth}
                onChange={(e) => setDepth(Number.parseInt(e.target.value, 10))}
              >
                <option value={1}>{t('reports.depthTopLevel', { defaultValue: '1 (top-level)' })}</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4</option>
              </select>
            </label>
          )}
          {kind !== 'serp-check' && (
          <span className="ml-auto text-surface-500">
            {loading
              ? t('common.loading', { defaultValue: 'Loading…' })
              : t('reports.summary', {
                  defaultValue: '{{rows}} rows · {{urls}} URLs',
                  rows: rows.length.toLocaleString(),
                  urls: total.toLocaleString(),
                })}
          </span>
          )}
        </div>

        {kind === 'serp-check' ? (
          <SerpCheckPanel />
        ) : (
        <div ref={scrollRef} className="flex-1 overflow-auto px-4 py-3 text-[11px]">
          {rows.length === 0 && !loading && (
            <div className="p-6 text-center text-surface-500">
              {notComputed
                ? t('sidebar.notComputed', { defaultValue: 'Not computed' })
                : LINK_TARGET_KINDS.has(kind)
                  ? t('reports.noLinkTargets', { defaultValue: 'No such links in this crawl.' })
                  : t('reports.noData', { defaultValue: 'No data — run a crawl first.' })}
            </div>
          )}
          {rows.length > 0 && kind === 'top-words' && topView === 'cloud' && (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 leading-tight">
              {cloudSizes(rows).map((px, i) => (
                <span
                  key={rows[i]!.id ?? rows[i]!.key}
                  className="text-surface-100"
                  style={{ fontSize: `${px}px` }}
                  title={`${rows[i]!.badge ? rows[i]!.badge + ': ' : ''}${rows[i]!.valueLabel ?? rows[i]!.count}`}
                >
                  {rows[i]!.key}
                </span>
              ))}
            </div>
          )}
          {rows.length > 0 && !(kind === 'top-words' && topView === 'cloud') && (
            <div className="w-full">
              <div className="sticky top-0 z-10 flex bg-surface-900 text-surface-400">
                <div className="w-2/3 py-1 pr-3 text-left font-medium">{keyLabels[kind]}</div>
                <div className="w-24 py-1 pr-3 text-right font-medium">{t('reports.count', { defaultValue: 'Count' })}</div>
                <div className="flex-1 py-1 text-left font-medium">{t('reports.share', { defaultValue: 'Share' })}</div>
              </div>
              <div className="relative" style={{ height: rowVirtualizer.getTotalSize() }}>
                {rowVirtualizer.getVirtualItems().map((vi) => {
                  const r = rows[vi.index];
                  if (!r) return null;
                  const widthPct = max > 0 ? Math.round((r.count / max) * 100) : 0;
                  const sharePct = total > 0 ? ((r.count / total) * 100).toFixed(1) : '0.0';
                  return (
                    <div
                      key={r.id ?? r.key}
                      data-index={vi.index}
                      ref={rowVirtualizer.measureElement}
                      className="absolute left-0 top-0 flex w-full border-b border-surface-900 hover:bg-surface-900/50"
                      style={{ transform: `translateY(${vi.start}px)` }}
                    >
                      <div className="w-2/3 break-all py-1 pr-3 align-top font-mono text-surface-100">
                        {r.badge && (
                          <span className="mr-2 rounded bg-surface-800 px-1.5 py-0.5 text-[9px] uppercase text-surface-400">
                            {r.badge}
                          </span>
                        )}
                        {r.key}
                        {r.detail && (
                          <div className="text-[10px] text-surface-500">{r.detail}</div>
                        )}
                      </div>
                      <div className="w-24 py-1 pr-3 text-right align-top font-mono text-surface-100">
                        {r.valueLabel ?? r.count.toLocaleString()}
                      </div>
                      <div className="flex-1 py-1 align-top">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-32 rounded bg-surface-800">
                            <div
                              className="h-full rounded bg-blue-600"
                              style={{ width: `${widthPct}%` }}
                            />
                          </div>
                          <span className="font-mono text-[10px] text-surface-400">
                            {sharePct}%
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-surface-800 px-4 py-2.5">
          <button
            className="rounded border border-surface-700 px-3 py-1 text-[11px] hover:bg-surface-800"
            onClick={onClose}
          >
            {t('common.close', { defaultValue: 'Close' })}
          </button>
        </div>
      </div>
    </div>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

/** A status code, or «No response» when the request got no HTTP answer. */
function statusText(status: number | null, t: Translate): string {
  return status === null ? t('reports.noResponse', { defaultValue: 'No response' }) : String(status);
}

/** A redirect end's status. A chain end the crawl never fetched (beyond
 *  Max URLs, out of scope) has no status either, but it is not a failure. */
function finalStatusText(row: LinkTargetRow, t: Translate): string {
  if (row.finalStatusCode !== null || row.finalIndexability === 'non-indexable:no-response')
    return statusText(row.finalStatusCode, t);
  return t('reports.notCrawled', { defaultValue: 'Not crawled' });
}

function statusBadge(status: number | null, t: Translate): string {
  if (status === null) return t('reports.badge.net', { defaultValue: 'NET' });
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return '?';
}

/**
 * One-letter perf class for a response-time bucket label. Lets users skim
 * the histogram for "where am I losing performance?" without re-reading
 * the bucket boundaries.
 */
function rtBadge(label: string, t: Translate): string {
  if (label === 'No response') return t('reports.badge.err', { defaultValue: 'ERR' });
  if (label === '< 100ms' || label === '100–500ms') return t('reports.badge.ok', { defaultValue: 'OK' });
  if (label === '500ms–1s') return t('reports.badge.warn', { defaultValue: 'WARN' });
  return t('reports.badge.slow', { defaultValue: 'SLOW' });
}

/** Histogram bucket labels come from the database; only two carry words. */
function bucketLabel(label: string, t: Translate): string {
  if (label === 'No response') return t('reports.noResponse', { defaultValue: 'No response' });
  if (label === '0 (orphan)') return t('reports.bucketOrphan', { defaultValue: '0 (orphan)' });
  return label;
}

function pageCountLabel(n: number, t: Translate): string {
  return t('reports.pageCount', {
    defaultValue_one: '{{formatted}} page',
    defaultValue_other: '{{formatted}} pages',
    defaultValue: '{{formatted}} pages',
    count: n,
    formatted: n.toLocaleString(),
  });
}

/** The page region a link sits in (`links.link_position`). */
function linkPositionLabel(value: string, t: Translate): string {
  switch (value) {
    case 'navigation':
      return t('reports.position.navigation', { defaultValue: 'Navigation' });
    case 'header':
      return t('reports.position.header', { defaultValue: 'Header' });
    case 'content':
      return t('reports.position.content', { defaultValue: 'Content' });
    case 'sidebar':
      return t('reports.position.sidebar', { defaultValue: 'Sidebar' });
    case 'footer':
      return t('reports.position.footer', { defaultValue: 'Footer' });
    case 'aside':
      return t('reports.position.aside', { defaultValue: 'Aside' });
    default:
      return value;
  }
}

/**
 * Friendly label for the `indexability` enum the crawler writes. Keeps the
 * machine-friendly token (`non-indexable:robots-blocked`) out of the UI so
 * the dropdown reads naturally — Title Case + human-readable suffix.
 */
function indexabilityLabel(value: string, t: Translate): string {
  switch (value) {
    case 'indexable':
      return t('reports.indexability.indexable', { defaultValue: 'Indexable' });
    case 'non-indexable:noindex':
      return t('reports.indexability.noindex', { defaultValue: 'Non-indexable — noindex' });
    case 'non-indexable:canonical':
      return t('reports.indexability.canonical', { defaultValue: 'Non-indexable — canonicalised' });
    case 'non-indexable:robots-blocked':
      return t('reports.indexability.robotsBlocked', { defaultValue: 'Non-indexable — blocked by robots.txt' });
    case 'non-indexable:redirect':
      return t('reports.indexability.redirect', { defaultValue: 'Non-indexable — redirect' });
    case 'non-indexable:client-error':
      return t('reports.indexability.clientError', { defaultValue: 'Non-indexable — 4xx' });
    case 'non-indexable:server-error':
      return t('reports.indexability.serverError', { defaultValue: 'Non-indexable — 5xx' });
    case 'non-indexable:no-response':
      return t('reports.indexability.noResponse', { defaultValue: 'Non-indexable — no response' });
    case 'unknown:bot-blocked':
      return t('reports.indexability.botBlocked', { defaultValue: 'Unknown — blocked by bot protection' });
    default:
      return value;
  }
}

/**
 * Friendly label for the `content_kind` enum (html / css / js / image /
 * font / pdf / other). Upper-cases acronyms (HTML/CSS/JS/PDF) so the chart
 * matches the way users talk about file types.
 */
function contentKindLabel(value: string, t: Translate): string {
  switch (value) {
    case 'html':
      return 'HTML';
    case 'css':
      return 'CSS';
    case 'js':
      return 'JavaScript';
    case 'image':
      return t('reports.kind.image', { defaultValue: 'Image' });
    case 'font':
      return t('reports.kind.font', { defaultValue: 'Font' });
    case 'pdf':
      return 'PDF';
    case 'other':
      return t('reports.kind.other', { defaultValue: 'Other' });
    default:
      return value;
  }
}
