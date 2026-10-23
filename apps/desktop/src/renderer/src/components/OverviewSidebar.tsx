import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Info } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  ISSUE_GROUPS,
  issueCount,
  issueSourcesCount,
  type IssueCheckDef,
  type CheckTrend,
  type IssueTrend,
  type OverviewCounts,
  type UrlCategory,
} from '@freecrawl/shared-types';
import { useAppStore } from '../store.js';
import { translateLabel } from '../i18n/labels.js';

interface Node {
  key: string;
  label: string;
  category?: UrlCategory;
  /** `null` = the counter exists but was never computed ("Not computed"). */
  count?: number | null;
  /** Denominator for this node's "% of Total". Defaults to the tree-wide
   *  total (internal URLs). Nodes whose count isn't internal-scoped override
   *  it: image nodes use the total image count (so an image ÷ page ratio is
   *  never bogus), and Response Codes / Security use internal+external (they
   *  count external URLs, so an internal-only base would exceed 100%). */
  percentBase?: number;
  /** The check is switched off by a crawl setting, so there is no count to
   *  show — rendered as "Off" instead of a misleading 0. */
  off?: boolean;
  /** The count is link targets, not URLs: no share of the total, and this
   *  tooltip says what the number and the list (pages or links) are. */
  targetHint?: string;
  /** Tooltip of a row that is not counted by target (site-wide group and its checks). */
  hint?: string;
  /** Site-wide check: its share of the pages answered 2xx, shown instead of
   *  "% of Total" (its own count may include redirects or unfetched rows). */
  share?: number;
  /** The check's count in the previous crawl and the change since (B23). */
  trend?: CheckTrend;
  children?: Node[];
}

/** Tooltip of a check counted by target, for `buildTree`. */
type TargetHint = (def: IssueCheckDef, targets: number | null, sources: number | null) => string;

/** Tooltips of the site-wide group, for `buildTree`. */
interface SiteWideText {
  group: string;
  share: (pages: number, base: number) => string;
}

export function OverviewSidebar() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const overview = useAppStore((s) => s.overview);
  const setOverview = useAppStore((s) => s.setOverview);
  const dataVersion = useAppStore((s) => s.dataVersion);
  // Subscribe to scalar fields of `progress` rather than the whole
  // object. Zustand re-renders this component only when these specific
  // values change — so the 5/s progress events that don't move the
  // crawled count (the in-flight pending fluctuates every poll) no
  // longer trigger a full sidebar re-render.
  const progressRunning = useAppStore((s) => s.progress?.running ?? false);
  const progressCrawled = useAppStore((s) => s.progress?.crawled ?? 0);
  const activeCategory = useAppStore((s) => s.activeCategory);
  const navigateToCategory = useAppStore((s) => s.navigateToCategory);
  const requestReport = useAppStore((s) => s.requestReport);
  // Monotonic guard shared by the polling effect and the progress-driven
  // refetch — both call overviewGet(), and on the multi-worker reader
  // pool a slower response can resolve after a fresher one. Applying
  // results strictly in issue order stops a stale count overwriting a
  // newer one.
  const overviewSeqRef = useRef(0);
  const overviewAppliedRef = useRef(0);
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set([
      'summary',
      'crawl-data',
      'response-codes',
      'security',
      'indexability',
      'issues',
      'issues-title',
      'issues-meta',
      'issues-h1',
      'issues-content',
      'issues-response',
      'issues-images',
      'issues-links',
    ]),
  );

  // Background polling. Independent of `progress.crawled` so a busy
  // crawl that fires progress events twice per second doesn't restart
  // the interval (and re-fire `load()` immediately) on every tick.
  // Dependency is `dataVersion` only — bumped from elsewhere when a
  // user-initiated mutation needs an immediate refresh.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      // Coalesce overlapping calls — getOverviewCounts is an aggregate
      // SQL pass over 70+ issue WHERE clauses; on a 1M-URL DB it can
      // run ~200–500 ms and main-process IPC handlers run serially, so
      // overlapping calls just queue up and starve other IPCs.
      if (inFlight) return;
      inFlight = true;
      const seq = ++overviewSeqRef.current;
      try {
        const o = await window.freecrawl.overviewGet();
        if (!cancelled && seq > overviewAppliedRef.current) {
          overviewAppliedRef.current = seq;
          setOverview(o);
        }
      } catch {
        // Heavy aggregates no longer fall back to the main thread when
        // the reader worker is down — the call rejects instead. Keep
        // the previous counts; the next poll tick retries against the
        // respawned worker.
      } finally {
        inFlight = false;
      }
    };
    // Wrap in requestIdleCallback so the 70+ issue-counter aggregate
    // only fires when the renderer's event loop is idle. The tick still
    // runs at 3 s cadence (the interval itself), but each individual
    // tick yields to user input — the difference between "click → 200
    // ms freeze" and "click → instant" while crawl is running.
    interface RequestIdleCallback {
      (cb: () => void, opts?: { timeout: number }): number;
    }
    const w = window as Window & { requestIdleCallback?: RequestIdleCallback };
    const scheduleLoad = (): void => {
      if (typeof w.requestIdleCallback === 'function') {
        w.requestIdleCallback(() => void load(), { timeout: 4000 });
      } else {
        void load();
      }
    };
    scheduleLoad();
    // I-4 — Crawl-aware cadence. While the crawler is running we want
    // sub-5-second freshness so the sidebar feels live; idle (no
    // crawl, viewing existing project data) we slow to 30 s because
    // the data isn't changing and burning a 130-counter aggregate
    // every 3 s for nothing wastes battery and disk on laptops.
    // The crawler's `progress` event also bumps `progress.crawled`
    // which triggers a separate progress-driven refetch below, so
    // this interval is just a safety net.
    const intervalMs = progressRunning ? 3000 : 30_000;
    const id = setInterval(scheduleLoad, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [dataVersion, setOverview, progressRunning]);

  // Progress-driven refetch. When the crawler reports a meaningful
  // change (every 50 URLs crawled) we trigger an immediate sidebar
  // refresh — push semantics on top of the polling safety-net above.
  // `lastRefetchAt` ref prevents the same crawled-bucket from firing
  // twice if React re-renders for an unrelated reason.
  const lastRefetchAtRef = useRef(0);
  useEffect(() => {
    if (!progressRunning) return;
    const bucket = Math.floor(progressCrawled / 50);
    if (bucket === lastRefetchAtRef.current) return;
    lastRefetchAtRef.current = bucket;
    const seq = ++overviewSeqRef.current;
    void window.freecrawl
      .overviewGet()
      .then((o) => {
        if (seq > overviewAppliedRef.current) {
          overviewAppliedRef.current = seq;
          setOverview(o);
        }
      })
      .catch(() => {
        // Reader worker down — keep previous counts, retry next bucket.
      });
  }, [progressCrawled, progressRunning, setOverview]);

  // B23 — each check against the previous crawl. Hidden while a crawl runs:
  // the live counts are not a finished crawl. Refetched on every data change
  // (a project opened) and on crawl done: the crawler records the run after
  // its last progress frame, so the frame alone would read the old pair.
  const [trend, setTrend] = useState<IssueTrend | null>(null);
  const [crawlsDone, setCrawlsDone] = useState(0);
  useEffect(() => window.freecrawl.onDone(() => setCrawlsDone((n) => n + 1)), []);
  useEffect(() => {
    if (progressRunning) {
      setTrend(null);
      return;
    }
    let cancelled = false;
    void window.freecrawl
      .monitorIssueTrend()
      .then((tr) => {
        if (!cancelled) setTrend(tr);
      })
      .catch(() => {
        if (!cancelled) setTrend(null);
      });
    return () => {
      cancelled = true;
    };
  }, [dataVersion, progressRunning, crawlsDone]);

  const toggle = (k: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  // The tree itself only depends on `overview`. Memoising it skips the
  // 150-node object construction on every progress-driven render.
  const disabledIssues = useAppStore((s) => s.config.disabledIssues);
  const disabledSet = useMemo(() => new Set<string>(disabledIssues ?? []), [disabledIssues]);
  // Under "Reject all" the crawler skips Set-Cookie analysis altogether, so
  // the three cookie checks have nothing to count: a 0 there read as "no
  // insecure cookies" on a site that sets them on every page.
  const cookiesOff = useAppStore((s) => (s.config.cookiePolicy ?? 'reject-all') === 'reject-all');
  const targetHint = useMemo<TargetHint>(() => {
    const reportNames: Record<string, string> = {
      'redirect-inlinks': t('reports.report.redirectInlinks', { defaultValue: 'Links to Redirects (by Target)' }),
      'error-inlinks': t('reports.report.errorInlinks', { defaultValue: 'Links to Error Pages (by Target)' }),
    };
    return (def, targets, sources) => {
      const values = { targets: (targets ?? 0).toLocaleString(), sources: (sources ?? 0).toLocaleString() };
      const what =
        def.byTarget?.unit === 'links'
          ? t('sidebar.byTargetLinks', {
              defaultValue: 'Link targets: {{targets}} · links to them: {{sources}}. The list shows the links.',
              ...values,
            })
          : t('sidebar.byTargetPages', {
              defaultValue:
                'Link targets: {{targets}} · linking pages: {{sources}}. The list shows the linking pages.',
              ...values,
            });
      const report = def.byTarget?.report;
      return report
        ? `${what} ${t('sidebar.byTargetReport', {
            defaultValue: 'One row per target: Reports → {{report}}.',
            report: reportNames[report] ?? report,
          })}`
        : what;
    };
  }, [t]);
  const siteWideText = useMemo<SiteWideText>(
    () => ({
      group: t('sidebar.siteWideHint', {
        defaultValue:
          'Found on almost every page: one fix in the site template or server settings.',
      }),
      share: (pages, base) =>
        t('sidebar.siteWideShare', {
          defaultValue: '{{pages}} of {{base}} pages answered 200',
          pages: pages.toLocaleString(),
          base: base.toLocaleString(),
        }),
    }),
    [t],
  );
  const tree = useMemo(
    () => buildTree(overview, disabledSet, cookiesOff, targetHint, siteWideText, trend),
    [overview, disabledSet, cookiesOff, targetHint, siteWideText, trend],
  );
  const trendHint = useMemo(() => {
    if (!trend) return (_previous: number) => '';
    const date = new Date(trend.previousFinishedAt).toLocaleDateString(lang);
    const version = trend.toolVersionChanged
      ? ` ${t('sidebar.trendVersion', {
          defaultValue:
            'The two crawls ran on different FreeCrawl versions, so the change may come from the check, not the site.',
        })}`
      : '';
    return (previous: number) =>
      t('sidebar.trendPrevious', {
        defaultValue: 'Previous crawl, {{date}}: {{previous}}',
        date,
        previous: previous.toLocaleString(),
      }) + version;
  }, [trend, lang, t]);
  const offLabel = t('sidebar.checkOff', { defaultValue: 'Off' });
  const notComputedLabel = t('sidebar.notComputed', { defaultValue: 'Not computed' });
  const notComputedHint = t('sidebar.notComputedHint', {
    defaultValue:
      'Inlinks have not been computed yet, so orphan pages cannot be counted. They are computed at the end of a crawl that has "Recompute inlinks" on.',
  });
  const cookiesOffHint = t('sidebar.cookiesOffHint', {
    defaultValue:
      'Cookie checks are off because the crawl\'s cookie policy is "Reject all". Choose "Accept all" or "Block third-party" under Settings → Cookies to analyse Set-Cookie headers.',
  });
  const totalForPercent = overview?.summary.totalInternalUrls ?? 0;
  const soft404Probe = overview?.site?.soft404Probe ?? null;
  const botBlocked = overview?.site?.botBlocked ?? null;
  const sitemapFindings = overview?.site?.sitemapFindings ?? null;
  const fileUrls = (files: { url: string }[] | undefined) => (files ?? []).map((f) => f.url);
  const stoppedAt = overview?.site?.crawlStoppedAtLimit ?? null;
  const crawlTraps = overview?.site?.crawlTraps ?? [];
  const sitemapNotices: {
    key: string;
    info: boolean;
    items: string[];
    count: number;
    title: string;
    hint: string;
    note?: string;
    onClick?: () => void;
  }[] = [
    {
      key: 'crawlTrap',
      info: false,
      items: crawlTraps.flatMap((f) => f.samples.slice(0, 3)).slice(0, 3),
      count: crawlTraps.length,
      title: t('sidebar.siteCrawlTrap', { defaultValue: 'Possible crawl trap' }),
      hint: t('sidebar.siteCrawlTrapHint', {
        defaultValue:
          'The crawl found far more URLs in one pattern or section than the site is expected to have: {{list}}. The crawl was not stopped. To cut it off, add an exclude pattern or lower the page limit.',
        list: crawlTraps
          .map((f) =>
            f.expected !== null
              ? t('sidebar.siteCrawlTrapItemSitemap', {
                  defaultValue: '{{key}}: {{count}} URLs, the sitemap lists {{expected}}',
                  key: f.key,
                  count: f.count,
                  expected: f.expected,
                })
              : t('sidebar.siteCrawlTrapItem', {
                  defaultValue: '{{key}}: {{count}} URLs',
                  key: f.key,
                  count: f.count,
                }),
          )
          .join('; '),
      }),
    },
    {
      key: 'overUrls',
      info: false,
      items: fileUrls(sitemapFindings?.overUrls),
      count: sitemapFindings?.overUrls.length ?? 0,
      title: t('sidebar.siteSitemapOverUrls', { defaultValue: 'Sitemap over 50,000 URLs' }),
      hint: t('sidebar.siteSitemapOverUrlsHint', {
        defaultValue:
          'Search engines read at most 50,000 URLs per sitemap file. Split the file and list the parts in a sitemap index.',
      }),
    },
    {
      key: 'overSize',
      info: false,
      items: fileUrls(sitemapFindings?.overSize),
      count: sitemapFindings?.overSize.length ?? 0,
      title: t('sidebar.siteSitemapOverSize', { defaultValue: 'Sitemap over 50 MB' }),
      hint: t('sidebar.siteSitemapOverSizeHint', {
        defaultValue:
          'Search engines read at most 50 MB uncompressed per sitemap file. Split the file and list the parts in a sitemap index.',
      }),
    },
    {
      key: 'duplicateEntries',
      info: false,
      items: fileUrls(sitemapFindings?.duplicateEntries),
      count: sitemapFindings?.duplicateEntries.length ?? 0,
      title: t('sidebar.siteSitemapDuplicates', { defaultValue: 'Sitemap lists a URL twice' }),
      hint: t('sidebar.siteSitemapDuplicatesHint', {
        defaultValue:
          'These sitemap files list the same URL more than once. Each URL should appear once per file; the Sitemap Files export has the count per file.',
      }),
    },
    {
      key: 'inSeveral',
      info: true,
      items: sitemapFindings?.inSeveral.sample ?? [],
      count: sitemapFindings?.inSeveral.count ?? 0,
      title: t('sidebar.siteSitemapInSeveral', { defaultValue: 'URL in several sitemaps' }),
      hint: t('sidebar.siteSitemapInSeveralHint', {
        defaultValue:
          'These URLs are listed in two or more sitemap files. That is not necessarily a problem. The first few are shown; the Sitemap URLs export has the number of files for every URL.',
      }),
    },
    {
      key: 'notCrawled',
      info: true,
      items: [],
      count: overview?.issues.sitemapNotCrawled ?? 0,
      title: t('sidebar.siteSitemapNotCrawled', { defaultValue: 'Sitemap URLs not crawled' }),
      hint: t('sidebar.siteSitemapNotCrawledHint', {
        defaultValue:
          'These URLs are listed in a sitemap but the crawl never reached them: no internal link leads to them, or the crawl stopped first. Click to open the list.',
      }),
      note:
        stoppedAt !== null
          ? t('sidebar.crawlStoppedAtLimit', {
              defaultValue: 'The crawl stopped at its limit of {{n}} pages.',
              n: stoppedAt,
            })
          : undefined,
      onClick: () => requestReport('sitemap-orphans'),
    },
  ].filter((n) => n.count > 0);

  return (
    <div className="flex h-full flex-col bg-surface-900">
      <div className="flex items-center border-b border-surface-800 bg-surface-850 px-2 py-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-surface-400">
          {t('sidebar.overview', { defaultValue: 'Overview' })}
        </div>
        <div className="ml-auto flex items-center gap-3 text-[10px] text-surface-500">
          <span>{t('sidebar.urls', { defaultValue: 'URLs' })}</span>
          <span>{t('sidebar.percentOfTotal', { defaultValue: '% of Total' })}</span>
        </div>
      </div>
      {botBlocked && (
        // The crawl itself is incomplete — said up front, because every
        // count below silently lacks these pages otherwise.
        <button
          type="button"
          className="flex w-full items-start gap-1.5 border-b border-amber-700/40 bg-amber-900/20 px-2 py-1.5 text-left text-[11px] text-amber-200 hover:bg-amber-900/30"
          title={t('sidebar.siteBotBlockedHint', {
            defaultValue:
              "The site's bot protection answered with a challenge instead of these pages. They were not crawled and are left out of the broken-link and sitemap checks. Lower the crawl speed or allowlist the crawler's user agent, then re-crawl them.",
          })}
          onClick={() => navigateToCategory('status:bot-blocked')}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {t('sidebar.siteBotBlocked', { defaultValue: 'Bot protection blocked part of the crawl' })}
            </div>
            {botBlocked.sample && (
              <div className="break-all font-mono text-[10px] text-amber-300/80">{botBlocked.sample}</div>
            )}
          </div>
          <span className="shrink-0 font-mono tabular-nums">{botBlocked.count.toLocaleString()}</span>
        </button>
      )}
      {soft404Probe && (
        // A finding about the whole site, not a URL list — so a notice
        // rather than a tree node with a count and a filter behind it.
        <div
          className="flex items-start gap-1.5 border-b border-amber-700/40 bg-amber-900/20 px-2 py-1.5 text-[11px] text-amber-200"
          title={t('sidebar.siteSoft404Hint', {
            defaultValue:
              'A request for a page that does not exist was answered {{status}} instead of 404, so broken links on this site look like working pages to search engines.',
            status: soft404Probe.status,
          })}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium">
              {t('sidebar.siteSoft404', {
                defaultValue: 'Missing pages return {{status}} (soft 404)',
                status: soft404Probe.status,
              })}
            </div>
            <div className="break-all font-mono text-[10px] text-amber-300/80">
              {soft404Probe.finalUrl
                ? `${soft404Probe.url} → ${soft404Probe.finalUrl}`
                : soft404Probe.url}
            </div>
          </div>
        </div>
      )}
      {sitemapNotices.map((n) => {
        // About sitemap files, not crawled URLs: the files are the list.
        // An entry with a list behind it (B76) is a button that opens it.
        const Tag = n.onClick ? 'button' : 'div';
        return (
          <Tag
            key={n.key}
            type={n.onClick ? 'button' : undefined}
            onClick={n.onClick}
            className={
              n.info
                ? `flex w-full items-start gap-1.5 border-b border-surface-800 px-2 py-1.5 text-left text-[11px] text-surface-300${n.onClick ? ' hover:bg-surface-800' : ''}`
                : 'flex items-start gap-1.5 border-b border-amber-700/40 bg-amber-900/20 px-2 py-1.5 text-[11px] text-amber-200'
            }
            title={n.hint}
          >
            {n.info ? (
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="font-medium">{n.title}</div>
              {n.note && <div className="text-[10px] text-surface-500">{n.note}</div>}
              {n.items.map((url) => (
                <div
                  key={url}
                  className={`break-all font-mono text-[10px] ${n.info ? 'text-surface-500' : 'text-amber-300/80'}`}
                >
                  {url}
                </div>
              ))}
            </div>
            <span className="shrink-0 font-mono tabular-nums">{n.count.toLocaleString()}</span>
          </Tag>
        );
      })}
      <div className="flex-1 overflow-auto">
        <div className="py-1 text-[11px]">
          {tree.map((node) => (
            <TreeNode
              key={node.key}
              node={node}
              depth={0}
              expanded={expanded}
              toggle={toggle}
              activeCategory={activeCategory}
              onClick={navigateToCategory}
              total={totalForPercent}
              lang={lang}
              offLabel={offLabel}
              offHint={cookiesOffHint}
              notComputedLabel={notComputedLabel}
              notComputedHint={notComputedHint}
              trendHint={trendHint}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const TreeNode = memo(function TreeNode({
  node,
  depth,
  expanded,
  toggle,
  activeCategory,
  onClick,
  total,
  lang,
  offLabel,
  offHint,
  notComputedLabel,
  notComputedHint,
  trendHint,
}: {
  node: Node;
  depth: number;
  expanded: Set<string>;
  toggle: (k: string) => void;
  activeCategory: UrlCategory;
  onClick: (c: UrlCategory) => void;
  total: number;
  lang: string;
  offLabel: string;
  offHint: string;
  notComputedLabel: string;
  notComputedHint: string;
  trendHint: (previous: number) => string;
}) {
  const isExpanded = expanded.has(node.key);
  const isActive = node.category && node.category === activeCategory;
  const hasChildren = (node.children?.length ?? 0) > 0;

  return (
    <>
      <div
        className={clsx(
          'group flex cursor-pointer items-center gap-1 px-2 py-1 hover:bg-surface-800',
          isActive && 'bg-accent-500/20 text-surface-50',
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
        title={node.hint ?? node.targetHint}
        onClick={() => {
          if (hasChildren) toggle(node.key);
          if (node.category) onClick(node.category);
        }}
      >
        {hasChildren ? (
          isExpanded ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-surface-500" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-surface-500" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate text-surface-200">{translateLabel(node.label, lang)}</span>
        {node.off && (
          <span className="w-[4.5rem] text-right font-mono italic text-surface-500" title={offHint}>
            {offLabel}
          </span>
        )}
        {!node.off && node.count === null && (
          <span
            className="shrink-0 whitespace-nowrap text-right font-mono italic text-surface-500"
            title={notComputedHint}
          >
            {notComputedLabel}
          </span>
        )}
        {!node.off && node.count != null && node.trend && node.trend.change !== 0 && (
          <span
            className="mr-1 shrink-0 font-mono tabular-nums text-surface-400"
            title={trendHint(node.trend.previous)}
          >
            {node.trend.change > 0 ? '▲' : '▼'}
            {Math.abs(node.trend.change).toLocaleString()}
          </span>
        )}
        {!node.off && node.count != null && (
          <>
            <span className="font-mono tabular-nums text-surface-300">
              {node.count.toLocaleString()}
            </span>
            <span className="w-14 text-right font-mono tabular-nums text-surface-500">
              {(() => {
                // Targets are not a share of the site's URLs.
                if (node.targetHint) return '';
                if (node.share !== undefined) return (node.share * 100).toFixed(2) + '%';
                const base = node.percentBase ?? total;
                return base > 0 ? ((node.count / base) * 100).toFixed(2) + '%' : '—';
              })()}
            </span>
          </>
        )}
      </div>
      {isExpanded &&
        node.children?.map((child) => (
          <TreeNode
            key={child.key}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            toggle={toggle}
            activeCategory={activeCategory}
            onClick={onClick}
            total={total}
            lang={lang}
            offLabel={offLabel}
            offHint={offHint}
            notComputedLabel={notComputedLabel}
            notComputedHint={notComputedHint}
            trendHint={trendHint}
          />
        ))}
    </>
  );
});

function buildTree(
  o: OverviewCounts | null,
  disabled: ReadonlySet<string>,
  cookiesOff: boolean,
  targetHint: TargetHint,
  siteWideText: SiteWideText,
  trend: IssueTrend | null,
): Node[] {
  if (!o) return [];
  // Response Codes and Security deliberately count external URLs too (that's
  // how a broken outbound link surfaces), so their numerators exceed the
  // internal-only URL count. Their "% of Total" must therefore divide by the
  // full crawled set (internal + external), not `totalInternalUrls` — else
  // "All 6,657 / 6,555 = 109.30%" reads as a broken crawl. Every other group
  // is internal-scoped and keeps the default (internal) base.
  const allUrls = o.summary.totalInternalUrls + o.summary.totalExternalUrls;
  const checkNode = (i: IssueCheckDef): Node => ({
    key: i.key,
    label: i.label,
    count: issueCount(o.issues, i),
    category: i.category,
    ...(i.percentBase === 'images' ? { percentBase: o.summary.totalImages } : {}),
    ...(i.byTarget
      ? { targetHint: targetHint(i, issueCount(o.issues, i), issueSourcesCount(o.issues, i)) }
      : {}),
    ...(cookiesOff && i.category.startsWith('issues:cookie-') ? { off: true } : {}),
    ...(trend?.checks[i.category] ? { trend: trend.checks[i.category] } : {}),
  });
  // Checks on almost every page answered 2xx (`OverviewCounts.site.siteWide`).
  const siteWideBase = o.site?.siteWide?.pagesBase ?? 0;
  const siteWidePages = new Map<UrlCategory, number>(
    (o.site?.siteWide?.checks ?? []).map((c) => [c.category, c.pages]),
  );
  return [
    {
      key: 'summary',
      label: 'Summary',
      children: [
        {
          key: 'summary-internal',
          label: 'Total Internal URLs',
          count: o.summary.totalInternalUrls,
          category: 'internal:all',
        },
        {
          key: 'summary-indexable',
          label: 'Internal Indexable',
          count: o.summary.totalIndexable,
          category: 'indexability:indexable',
        },
        {
          key: 'summary-nonindexable',
          label: 'Internal Non-Indexable',
          count: o.summary.totalNonIndexable,
          category: 'indexability:non-indexable',
        },
      ],
    },
    {
      key: 'crawl-data',
      label: 'Crawl Data',
      children: [
        {
          key: 'internal',
          label: 'Internal',
          count: o.internal['all'],
          category: 'internal:all',
          children: [
            { key: 'int-html', label: 'HTML', count: o.internal['html'], category: 'internal:html' },
            { key: 'int-js', label: 'JavaScript', count: o.internal['js'], category: 'internal:js' },
            { key: 'int-css', label: 'CSS', count: o.internal['css'], category: 'internal:css' },
            {
              key: 'int-image',
              label: 'Images',
              count: o.internal['image'],
              category: 'internal:image',
            },
            { key: 'int-pdf', label: 'PDF', count: o.internal['pdf'], category: 'internal:pdf' },
            { key: 'int-font', label: 'Fonts', count: o.internal['font'], category: 'internal:font' },
            {
              key: 'int-other',
              label: 'Other',
              count: o.internal['other'],
              category: 'internal:other',
            },
          ],
        },
      ],
    },
    {
      key: 'response-codes',
      label: 'Response Codes',
      children: [
        { key: 'rc-all', label: 'All', count: o.responseCodes.all, category: 'all', percentBase: allUrls },
        {
          key: 'rc-blocked',
          label: 'Blocked by Robots',
          count: o.responseCodes.blockedRobots,
          category: 'status:blocked-robots',
          percentBase: allUrls,
        },
        {
          key: 'rc-bot-blocked',
          label: 'Blocked by Bot Protection',
          count: o.responseCodes.botBlocked,
          category: 'status:bot-blocked',
          percentBase: allUrls,
        },
        {
          key: 'rc-none',
          label: 'No Response',
          count: o.responseCodes.noResponse,
          category: 'status:no-response',
          percentBase: allUrls,
        },
        { key: 'rc-2xx', label: 'Success (2xx)', count: o.responseCodes.success2xx, category: 'status:2xx', percentBase: allUrls },
        {
          key: 'rc-3xx',
          label: 'Redirection (3xx)',
          count: o.responseCodes.redirect3xx,
          category: 'status:3xx',
          percentBase: allUrls,
        },
        {
          key: 'rc-4xx',
          label: 'Client Error (4xx)',
          count: o.responseCodes.clientError4xx,
          category: 'status:4xx',
          percentBase: allUrls,
        },
        {
          key: 'rc-5xx',
          label: 'Server Error (5xx)',
          count: o.responseCodes.serverError5xx,
          category: 'status:5xx',
          percentBase: allUrls,
        },
      ],
    },
    {
      key: 'security',
      label: 'Security',
      children: [
        {
          key: 'sec-https',
          label: 'HTTPS URLs',
          count: o.security.https,
          category: 'security:https',
          percentBase: allUrls,
        },
        {
          key: 'sec-http',
          label: 'HTTP URLs',
          count: o.security.http,
          category: 'security:http',
          percentBase: allUrls,
        },
      ],
    },
    {
      key: 'indexability',
      label: 'Indexability',
      children: [
        {
          key: 'ix-indexable',
          label: 'Indexable',
          count: o.indexability.indexable,
          category: 'indexability:indexable',
        },
        {
          key: 'ix-noindex',
          label: 'Noindex',
          count: o.indexability.noindex,
          category: 'indexability:noindex',
        },
        {
          key: 'ix-canonical',
          label: 'Canonicalised',
          count: o.indexability.canonicalised,
          category: 'indexability:canonicalised',
        },
        {
          key: 'ix-blocked',
          label: 'Blocked by Robots',
          count: o.indexability.blockedRobots,
          category: 'indexability:blocked-robots',
        },
      ],
    },
    {
      key: 'issues',
      label: 'Issues',
      // Generated from the shared issue catalog so the sidebar, the
      // Settings → Issues toggles and the database silence list can never
      // disagree about which checks exist. Disabled checks drop out of the
      // tree; a group with nothing left drops out with them. Site-wide
      // checks move out of their group into one group at the end.
      children: [
        ...ISSUE_GROUPS.map((g) => ({
          key: g.key,
          label: g.label,
          children: g.items
            .filter((i) => !disabled.has(i.category) && !siteWidePages.has(i.category))
            .map(checkNode),
        })),
        {
          key: 'issues-site-wide',
          label: 'Site-wide',
          hint: siteWideText.group,
          children: ISSUE_GROUPS.flatMap((g) => g.items)
            .filter((i) => !disabled.has(i.category) && siteWidePages.has(i.category))
            .map((i) => ({
              ...checkNode(i),
              hint: siteWideText.share(siteWidePages.get(i.category)!, siteWideBase),
              share: siteWidePages.get(i.category)! / siteWideBase,
            })),
        },
      ].filter((g) => g.children.length > 0),
    },
  ];
}
