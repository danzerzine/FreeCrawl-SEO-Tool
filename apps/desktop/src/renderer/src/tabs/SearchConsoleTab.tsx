import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { TabExportButton } from '../components/TabExportButton.js';
import { Loader2, Search, RefreshCw, Plus } from 'lucide-react';
import { InfoTip } from '../components/InfoTip.js';
import { GscBqPullDialog } from '../components/GscBqPullDialog.js';
import {
  defaultGscSettings,
  type GoogleAccount,
  type GoogleAuthState,
  type GscDateRange,
  type GscFetchMeta,
  type GscInspectPlan,
  type GscInspectProgress,
  type GscInspectRunResult,
  type GscPreset,
  type GscRichResultType,
  type GscRow,
  type GscSite,
} from '@freecrawl/shared-types';
import { useAppStore } from '../store.js';

const TOOLBAR_HEIGHT = 36;
const HEADER_HEIGHT = 26;
const STATUS_BAR_HEIGHT = 22;
const ROW_HEIGHT = 30;
const PAGE_SIZE = 2000;
const POLL_MS_RUNNING = 5000;
/** GSC URL Inspection daily quota is 2 000 per property — batch in
 *  small enough chunks that one click is reversible. */
const INSPECT_BATCH = 100;

/** What the tab is currently showing — drives the three-way render. */
// See AnalyticsTab — 'error' exists so a rejected bootstrap surfaces as a
// message with a Retry instead of an unending spinner.
type Stage = 'loading' | 'unconfigured' | 'disconnected' | 'ready' | 'error';

/** Quick-filter presets, mirroring Screaming Frog's GSC filter dropdown.
 *  `needsInspection` entries only match once URL Inspection has been run. */
const FILTER_PRESETS: { value: GscPreset; labelKey: string; label: string }[] = [
  { value: 'all', labelKey: 'gscTab.presetAll', label: 'All' },
  { value: 'clicks-above-0', labelKey: 'gscTab.presetClicks', label: 'Clicks Above 0' },
  { value: 'without-data', labelKey: 'gscTab.presetNoData', label: 'No Search Analytics Data' },
  {
    value: 'non-indexable-with-data',
    labelKey: 'gscTab.presetNonIndexableData',
    label: 'Non-Indexable with Search Analytics Data',
  },
  { value: 'orphan', labelKey: 'gscTab.presetOrphan', label: 'Orphan URLs' },
  { value: 'not-on-google', labelKey: 'gscTab.presetNotOnGoogle', label: 'URL is Not on Google' },
  {
    value: 'indexable-not-indexed',
    labelKey: 'gscTab.presetIndexableNotIndexed',
    label: 'Indexable URL Not Indexed',
  },
  {
    value: 'on-google-with-issues',
    labelKey: 'gscTab.presetOnGoogleIssues',
    label: 'URL is on Google But Has Issues',
  },
  {
    value: 'canonical-mismatch',
    labelKey: 'gscTab.presetCanonical',
    label: 'User-Declared Canonical Not Selected',
  },
  {
    value: 'not-mobile-friendly',
    labelKey: 'gscTab.presetMobile',
    label: 'Page is Not Mobile Friendly',
  },
  { value: 'amp-invalid', labelKey: 'gscTab.presetAmp', label: 'AMP URL Invalid' },
  { value: 'rich-result-invalid', labelKey: 'gscTab.presetRich', label: 'Rich Result Invalid' },
  {
    value: 'rich-result-warnings',
    labelKey: 'gscTab.presetRichWarnings',
    label: 'Rich Result Warnings Only',
  },
];

/** Average-position bands → cell colour (lower is better). */
function positionClass(v: number): string {
  if (v <= 0) return 'text-surface-600';
  if (v <= 10) return 'text-emerald-400';
  if (v <= 20) return 'text-amber-400';
  return 'text-red-400';
}

function relativeTime(iso: string): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const min = Math.floor((Date.now() - then) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function SearchConsoleTab() {
  const { t } = useTranslation();
  const dataVersion = useAppStore((s) => s.dataVersion);
  // Clicking a row opens its page in the Detail panel below, as in the URL
  // tables — without this the panel kept whatever another tab had picked.
  const selectedUrlId = useAppStore((s) => s.selectedUrlId);
  const setSelectedUrlId = useAppStore((s) => s.setSelectedUrlId);
  const setSelectedUrlIds = useAppStore((s) => s.setSelectedUrlIds);
  const crawlProgress = useAppStore((s) => s.progress);

  const [stage, setStage] = useState<Stage>('loading');
  const [authState, setAuthState] = useState<GoogleAuthState | null>(null);
  const [sites, setSites] = useState<GscSite[]>([]);
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [accountId, setAccountId] = useState('');
  const [property, setProperty] = useState('');
  const [dateRange, setDateRange] = useState<GscDateRange>('28d');
  const [rows, setRows] = useState<GscRow[]>([]);
  const [total, setTotal] = useState(0);
  const [meta, setMeta] = useState<GscFetchMeta | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<GscPreset>('all');
  const [connecting, setConnecting] = useState(false);
  /** B91: the project reads Search Console data from the user's BigQuery export, not the API. */
  const [fromBigQuery, setFromBigQuery] = useState(false);
  const [bqDialog, setBqDialog] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [inspectProgress, setInspectProgress] = useState<GscInspectProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The confirm dialog of the Inspect button: what will run, and whether recent pages are redone. */
  const [inspectDialog, setInspectDialog] = useState<{
    urls: string[];
    force: boolean;
    plan: GscInspectPlan | null;
  } | null>(null);
  const [inspectResult, setInspectResult] = useState<GscInspectRunResult | null>(null);
  /** Bumped by the error screen's Retry — re-runs the bootstrap effect. */
  const [retryNonce, setRetryNonce] = useState(0);
  /** After a pull: how many GSC URLs were missing from the crawl, and
   *  whether they were auto-queued (crawl-new-urls setting on). */
  const [newUrls, setNewUrls] = useState<{ count: number; queued: number } | null>(null);
  const [crawlingNew, setCrawlingNew] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadSites = useCallback(async (account?: string) => {
    const res = await window.freecrawl.gscListSites(account);
    if (!res.ok) {
      setError(res.error);
      setSites([]);
      return;
    }
    setError(null);
    setSites(res.sites);
    setProperty((prev) =>
      // Keep the current property only if the account can still see it.
      prev && res.sites.some((s) => s.siteUrl === prev) ? prev : (res.sites[0]?.siteUrl ?? ''),
    );
  }, []);

  /** Switch the project to another linked Google account: persist the
   *  choice, then re-list that account's properties and reload the table
   *  (each account's rows are stored separately). */
  const changeAccount = useCallback(
    (next: string) => {
      setAccountId(next);
      setNewUrls(null);
      void window.freecrawl.integrationSettingsSet('gsc', { accountId: next });
      void loadSites(next);
    },
    [loadSites],
  );

  // Resolve the tab's stage on mount: needs OAuth credentials, then a
  // connected account, before the data view is meaningful.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [integrations, auth, gscSettings] = await Promise.all([
          window.freecrawl.integrationsGetAll(),
          window.freecrawl.googleAuthStatus('gsc'),
          window.freecrawl.integrationSettingsGet('gsc'),
        ]);
        if (cancelled) return;
        setAuthState(auth);
        setAccounts(auth.accounts);
        // Seed the toolbar from the stored per-project GSC settings so the
        // account + property + date range persist across sessions. A stored
        // account that has since been unlinked falls back to the first one.
        const s = { ...defaultGscSettings(), ...(gscSettings ?? {}) };
        const account =
          auth.accounts.find((a) => a.accountId === s.accountId)?.accountId ??
          auth.accounts[0]?.accountId ??
          '';
        setAccountId(account);
        setDateRange(s.dateRange);
        if (s.property) setProperty(s.property);
        const configured = integrations['gsc']?.configured ?? false;
        setFromBigQuery(s.source === 'bigquery');
        if (s.source === 'bigquery') {
          // No Google sign-in is needed: the BigQuery service account reads the export.
          // Its key, project and dataset are checked here, not first at Pull (B181).
          const check = await window.freecrawl.gscBqCheck();
          if (cancelled) return;
          // A failed check (offline, revoked key) is a banner over the data pulled earlier, not a
          // replacement screen (B209).
          if (!check.ok) setError(check.error);
          setStage('ready');
        } else if (!configured) {
          setStage('unconfigured');
        } else if (!auth.connected) {
          setStage('disconnected');
        } else {
          setStage('ready');
          void loadSites(account);
        }
      } catch (e) {
        if (cancelled) return;
        // Every setStage above sits after the await, so a rejection here
        // used to pin the tab on its spinner permanently — the effect is
        // mount-only and never retried.
        setError(e instanceof Error ? e.message : String(e));
        setStage('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSites, retryNonce]);

  const reload = useCallback(async () => {
    const res = await window.freecrawl.gscQuery({
      limit: PAGE_SIZE,
      offset: 0,
      search: search || undefined,
      filter,
      accountId: accountId || undefined,
    });
    setRows(res.rows);
    setTotal(res.total);
    setMeta(res.meta);
  }, [search, filter, accountId]);

  // Candidate list — only while the data view is showing.
  useEffect(() => {
    if (stage !== 'ready') return;
    let cancelled = false;
    void reload();
    if (!crawlProgress?.running) return;
    const id = setInterval(() => {
      if (!cancelled) void reload();
    }, POLL_MS_RUNNING);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [stage, reload, dataVersion, crawlProgress?.running]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
    getItemKey: (index) => rows[index]?.url ?? `idx-${index}`,
  });

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const res = await window.freecrawl.googleAuthStart('gsc');
      setAuthState(res.state);
      setAccounts(res.state.accounts);
      if (res.ok && res.state.connected) {
        const account = res.state.accounts[0]?.accountId ?? '';
        setAccountId(account);
        setStage('ready');
        void loadSites(account);
      } else if (res.error) {
        setError(res.error);
      }
    } finally {
      setConnecting(false);
    }
  }, [loadSites]);

  /** Unlink the account currently selected in the toolbar. With several
   *  linked, the tab stays usable and falls back to the next one. */
  const disconnect = useCallback(async () => {
    const next = await window.freecrawl.googleAuthRevoke('gsc', accountId || undefined);
    setAuthState(next);
    setAccounts(next.accounts);
    setSites([]);
    setProperty('');
    if (!next.connected) {
      setAccountId('');
      setStage('disconnected');
      return;
    }
    const fallback = next.accounts[0]!.accountId;
    setAccountId(fallback);
    void window.freecrawl.integrationSettingsSet('gsc', { accountId: fallback });
    void loadSites(fallback);
  }, [accountId, loadSites]);

  const changeDateRange = useCallback((next: GscDateRange) => {
    setDateRange(next);
    void window.freecrawl.integrationSettingsSet('gsc', { dateRange: next });
  }, []);

  const runFetch = useCallback(async () => {
    if (!property || fetching) return;
    setFetching(true);
    setError(null);
    setNewUrls(null);
    try {
      // Date range + dimension filters + row cap come from the stored GSC
      // settings; the main process reads them. We only pass the property.
      const res = await window.freecrawl.gscFetch({
        property,
        accountId: accountId || undefined,
      });
      if (!res.ok) {
        setError(res.error);
      } else {
        setMeta(res.meta);
        setNewUrls({ count: res.newUrlCount ?? 0, queued: res.queuedNewUrls ?? 0 });
        await reload();
      }
    } finally {
      setFetching(false);
    }
  }, [property, accountId, fetching, reload]);

  const crawlNew = useCallback(async () => {
    if (crawlingNew) return;
    setCrawlingNew(true);
    setError(null);
    try {
      const res = await window.freecrawl.gscCrawlNewUrls();
      if (!res.ok) {
        setError(res.error);
      } else {
        setNewUrls({ count: res.candidateCount, queued: res.queued });
      }
    } finally {
      setCrawlingNew(false);
    }
  }, [crawlingNew]);

  const openInspect = useCallback(() => {
    if (!property || inspecting) return;
    const urls = rows.slice(0, INSPECT_BATCH).map((r) => r.url);
    if (urls.length === 0) return;
    setInspectResult(null);
    setInspectDialog({ urls, force: false, plan: null });
  }, [property, inspecting, rows]);

  // The dialog's counts come from main, which applies the same skip rule as the run itself.
  const dialogUrls = inspectDialog?.urls;
  const dialogForce = inspectDialog?.force ?? false;
  useEffect(() => {
    if (!dialogUrls || !property) return;
    let cancelled = false;
    void window.freecrawl
      .gscInspectPlan({
        property,
        urls: dialogUrls,
        accountId: accountId || undefined,
        force: dialogForce,
      })
      .then((plan) => {
        if (!cancelled) setInspectDialog((d) => (d ? { ...d, plan } : d));
      });
    return () => {
      cancelled = true;
    };
  }, [dialogUrls, dialogForce, property, accountId]);

  const runInspect = useCallback(async () => {
    if (!inspectDialog || !property || inspecting) return;
    const { urls, force } = inspectDialog;
    setInspectDialog(null);
    setInspecting(true);
    setError(null);
    try {
      setInspectResult(
        await window.freecrawl.gscInspectRun({
          property,
          urls,
          accountId: accountId || undefined,
          force,
        }),
      );
    } finally {
      setInspecting(false);
      setInspectProgress(null);
      void reload();
    }
  }, [inspectDialog, property, accountId, inspecting, reload]);

  // Live URL Inspection progress.
  useEffect(() => {
    const off = window.freecrawl.onGscInspectProgress((p) => {
      setInspectProgress(p.running ? p : null);
      if (!p.currentUrl) void reload();
    });
    return off;
  }, [reload]);

  // ── Gate states ──────────────────────────────────────────────────────
  if (stage === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-surface-950 text-[12px] text-surface-500">
        <Loader2 size={14} className="mr-2 animate-spin" />
        {t('gscTab.loading', { defaultValue: 'Loading…' })}
      </div>
    );
  }

  if (stage === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface-950 px-6 text-center">
        <div className="text-[13px] font-semibold text-rose-300">
          {t('common.loadFailedTitle', { defaultValue: "Couldn't load this view" })}
        </div>
        {error && <div className="max-w-md break-words text-[11px] text-surface-500">{error}</div>}
        <button
          type="button"
          className="mt-1 rounded border border-surface-700 px-3 py-1 text-[12px] text-surface-200 hover:bg-surface-800"
          onClick={() => {
            setError(null);
            setStage('loading');
            setRetryNonce((n) => n + 1);
          }}
        >
          {t('common.retry', { defaultValue: 'Retry' })}
        </button>
      </div>
    );
  }

  if (stage === 'unconfigured') {
    return (
      <GateMessage
        title={t('gscTab.unconfiguredTitle', {
          defaultValue: 'Google Search Console is not set up',
        })}
        body={t('gscTab.unconfiguredBody', {
          defaultValue:
            'Open Settings → Integrations → Google Search Console and paste your own Google Cloud OAuth client ID + secret (Desktop app type). Then come back here to connect.',
        })}
      />
    );
  }

  if (stage === 'disconnected') {
    return (
      <GateMessage
        title={t('gscTab.disconnectedTitle', {
          defaultValue: 'Connect your Search Console account',
        })}
        body={t('gscTab.disconnectedBody', {
          defaultValue:
            'Sign in with the Google account that owns the Search Console property. A browser window opens for consent — nothing leaves your machine except the standard Google OAuth exchange.',
        })}
      >
        <button
          type="button"
          onClick={() => void connect()}
          disabled={connecting}
          className="mt-3 inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-1.5 text-[12px] font-medium text-white hover:bg-blue-500 disabled:bg-surface-700 disabled:text-surface-500"
        >
          {connecting && <Loader2 size={13} className="animate-spin" />}
          {t('gscTab.connect', { defaultValue: 'Connect with Google' })}
        </button>
        {error && <div className="mt-3 max-w-md text-[11px] text-red-400">{error}</div>}
      </GateMessage>
    );
  }

  // ── Data view ────────────────────────────────────────────────────────
  return (
    <div className="relative flex h-full w-full flex-col bg-surface-950">
      <div
        className="flex items-center gap-2 border-b border-surface-800 bg-surface-900/40 px-3"
        style={{ height: TOOLBAR_HEIGHT }}
      >
        <div className="text-[12px] font-semibold tracking-wide text-surface-100">
          {t('gscTab.title', { defaultValue: 'Search Console' })}
        </div>
        <div className="relative w-48 min-w-[80px] shrink">
          <Search
            size={12}
            className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-surface-500"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('gscTab.filterPlaceholder', {
              defaultValue: 'Filter by URL…',
            })}
            className="h-6 w-full min-w-0 rounded border border-surface-700 bg-surface-950 pl-6 pr-2 text-[11px] text-surface-100 placeholder-surface-500 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <select
          className="h-6 max-w-[220px] rounded border border-surface-700 bg-surface-950 px-1.5 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none"
          value={filter}
          onChange={(e) => setFilter(e.target.value as GscPreset)}
          title={t('gscTab.presetTitle', {
            defaultValue: 'Pre-defined filters for URLs verified in GSC',
          })}
        >
          {FILTER_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {t(p.labelKey, { defaultValue: p.label })}
            </option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-2">
          <TabExportButton tab="search-console" disabled={total === 0} />
          {fromBigQuery && (
            <button
              type="button"
              onClick={() => setBqDialog(true)}
              className="inline-flex h-6 shrink-0 items-center whitespace-nowrap gap-1.5 rounded bg-blue-600 px-2.5 text-[11px] font-medium text-white hover:bg-blue-500"
              title={t('gscBq.buttonTitle', {
                defaultValue:
                  'Pull Search Console data from your BigQuery bulk export. Shows the estimated cost first.',
              })}
            >
              <RefreshCw size={12} />
              {t('gscBq.title', { defaultValue: 'Pull from BigQuery' })}
            </button>
          )}
          {!fromBigQuery && accounts.length > 1 && (
            <select
              className="h-6 max-w-[170px] rounded border border-surface-700 bg-surface-950 px-1.5 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none"
              value={accountId}
              onChange={(e) => changeAccount(e.target.value)}
              disabled={fetching || inspecting}
              title={t('gscTab.accountTitle', {
                defaultValue:
                  'Which linked Google account this project reports on. Each account keeps its own stored data.',
              })}
            >
              {accounts.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.email ?? a.accountId}
                </option>
              ))}
            </select>
          )}
          {!fromBigQuery && (
            <>
              <select
                className="h-6 max-w-[200px] rounded border border-surface-700 bg-surface-950 px-1.5 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none"
                value={property}
                onChange={(e) => setProperty(e.target.value)}
                disabled={fetching || sites.length === 0}
                title={property}
              >
                {sites.length === 0 && (
                  <option value="">
                    {t('gscTab.noProperties', { defaultValue: 'No properties' })}
                  </option>
                )}
                {sites.map((s) => (
                  <option key={s.siteUrl} value={s.siteUrl}>
                    {s.siteUrl}
                  </option>
                ))}
              </select>
              <select
                className="h-6 rounded border border-surface-700 bg-surface-950 px-1.5 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none"
                value={dateRange}
                onChange={(e) => changeDateRange(e.target.value as GscDateRange)}
                disabled={fetching}
                title={t('gscTab.dateRangeTitle', {
                  defaultValue:
                    'Date range for the pull. Full dimension filters live in Settings → Integrations → Google Search Console.',
                })}
              >
                <option value="7d">{t('gscTab.days7', { defaultValue: 'Last 7 days' })}</option>
                <option value="28d">{t('gscTab.days28', { defaultValue: 'Last 28 days' })}</option>
                <option value="90d">{t('gscTab.days90', { defaultValue: 'Last 90 days' })}</option>
                <option value="16m">
                  {t('gscTab.days16m', { defaultValue: 'Last 16 months' })}
                </option>
                <option value="custom">
                  {t('gscTab.daysCustom', { defaultValue: 'Custom (Settings)' })}
                </option>
              </select>
              <button
                type="button"
                onClick={() => void runFetch()}
                disabled={fetching || inspecting || !property}
                className="inline-flex h-6 shrink-0 items-center whitespace-nowrap gap-1.5 rounded bg-blue-600 px-2.5 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-surface-700 disabled:text-surface-500"
              >
                {fetching ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RefreshCw size={12} />
                )}
                {t('gscTab.fetch', { defaultValue: 'Fetch' })}
              </button>
              <button
                type="button"
                onClick={openInspect}
                disabled={inspecting || fetching || !property || rows.length === 0}
                className="inline-flex h-6 shrink-0 items-center whitespace-nowrap gap-1.5 rounded border border-surface-700 bg-surface-800 px-2.5 text-[11px] font-medium text-surface-200 hover:bg-surface-700 disabled:cursor-not-allowed disabled:opacity-50"
                title={t('gscTab.inspectTooltip', {
                  defaultValue:
                    'Run URL Inspection on the top {{n}} loaded pages (quota: 2 000/day per property)',
                  n: INSPECT_BATCH,
                })}
              >
                {inspecting && <Loader2 size={12} className="animate-spin" />}
                {t('gscTab.inspect', {
                  defaultValue: 'Inspect (top {{n}})',
                  n: INSPECT_BATCH,
                })}
              </button>
            </>
          )}
        </div>
      </div>

      {inspecting && inspectProgress && (
        <div className="flex items-center gap-2 border-b border-blue-700/40 bg-blue-900/20 px-3 py-1 text-[10px] text-blue-200">
          <Loader2 size={11} className="animate-spin" />
          {t('gscTab.inspecting', {
            defaultValue: 'Inspecting {{done}} / {{total}} — {{url}}',
            done: inspectProgress.done,
            total: inspectProgress.total,
            url: inspectProgress.currentUrl ?? '…',
          })}
        </div>
      )}

      {/* New-URLs-in-GSC banner — offer to crawl orphan GSC URLs */}
      {newUrls && newUrls.count > 0 && (
        <div className="flex items-center gap-2 border-b border-amber-700/40 bg-amber-900/15 px-3 py-1 text-[10px] text-amber-200">
          <span>
            {newUrls.queued > 0
              ? t('gscTab.newUrlsQueued', {
                  defaultValue_one:
                    '{{count}} new URL discovered in Search Console was added to the crawl.',
                  defaultValue_other:
                    '{{count}} new URLs discovered in Search Console were added to the crawl.',
                  count: newUrls.queued,
                })
              : t('gscTab.newUrlsFound', {
                  defaultValue_one:
                    '{{count}} URL appears in Search Console but was not found by the crawl.',
                  defaultValue_other:
                    '{{count}} URLs appear in Search Console but were not found by the crawl.',
                  count: newUrls.count,
                })}
          </span>
          {newUrls.queued === 0 && (
            <button
              type="button"
              onClick={() => void crawlNew()}
              disabled={crawlingNew}
              className="ml-auto inline-flex items-center gap-1 rounded bg-amber-600/80 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {crawlingNew ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
              {t('gscTab.crawlNewUrls', {
                defaultValue: 'Crawl {{n}} new URLs',
                n: newUrls.count,
              })}
            </button>
          )}
        </div>
      )}

      {/* Context line — connection + last pull */}
      <div className="flex items-center gap-2 border-b border-surface-800 bg-surface-900/20 px-3 py-1 text-[10px] text-surface-500">
        {fromBigQuery ? (
          <span>
            {t('gscBq.contextLine', {
              defaultValue: 'Data from your BigQuery export',
            })}
          </span>
        ) : (
          <>
            <span>
              {t('gscTab.connectedAs', {
                defaultValue: 'Connected as {{email}}',
                email:
                  accounts.find((a) => a.accountId === accountId)?.email ??
                  authState?.email ??
                  'Google account',
              })}
            </span>
            <button
              type="button"
              onClick={() => void disconnect()}
              className="text-surface-500 underline decoration-dotted hover:text-surface-300"
            >
              {t('gscTab.disconnect', { defaultValue: 'Disconnect' })}
            </button>
          </>
        )}
        {meta && (
          <span className="ml-auto">
            {t('gscTab.metaLine', {
              defaultValue:
                '{{property}} · {{start}} → {{end}} · {{rows}} pages with search data · fetched {{ago}}',
              property: meta.property,
              start: meta.startDate,
              end: meta.endDate,
              rows: meta.rowCount.toLocaleString(),
              ago: relativeTime(meta.fetchedAt),
            })}
          </span>
        )}
      </div>

      {error && (
        <div className="border-b border-red-700/40 bg-red-900/20 px-3 py-1 text-[10px] text-red-300">
          {error}
        </div>
      )}

      {inspectResult && (
        <div className="border-b border-surface-800 bg-surface-900/30 px-3 py-1 text-[10px] text-surface-300">
          {inspectResult.quotaExhausted
            ? t('gscTab.inspectQuota', {
                defaultValue:
                  "Google's daily limit for this property is used up (2 000 a day, 600 a minute); {{n}} pages were not inspected, try again tomorrow. {{inspected}} inspected, {{skipped}} skipped.",
                n: inspectResult.remaining,
                inspected: inspectResult.inspected,
                skipped: inspectResult.skipped,
              })
            : inspectResult.cancelled
              ? t('gscTab.inspectCancelled', {
                  defaultValue:
                    'Inspection cancelled: {{inspected}} inspected, {{skipped}} skipped, {{failed}} failed, {{n}} pages were not reached.',
                  inspected: inspectResult.inspected,
                  skipped: inspectResult.skipped,
                  failed: inspectResult.failed,
                  n: inspectResult.remaining,
                })
              : inspectResult.stopMessage
                ? t('gscTab.inspectStopped', {
                    defaultValue: 'Inspection stopped: {{message}} {{n}} pages were not inspected.',
                    message: inspectResult.stopMessage,
                    n: inspectResult.remaining,
                  })
                : t('gscTab.inspectDone', {
                    defaultValue:
                      '{{inspected}} inspected, {{skipped}} skipped (inspected in the last 24 hours), {{failed}} failed.',
                    inspected: inspectResult.inspected,
                    skipped: inspectResult.skipped,
                    failed: inspectResult.failed,
                  })}
        </div>
      )}

      {bqDialog && (
        <GscBqPullDialog onClose={() => setBqDialog(false)} onDone={() => void reload()} />
      )}

      {inspectDialog && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50">
          <div
            role="dialog"
            aria-label={t('gscTab.inspectDialogTitle', { defaultValue: 'URL Inspection' })}
            className="w-[420px] rounded border border-surface-700 bg-surface-900 p-4 text-[12px] text-surface-200 shadow-xl"
          >
            <div className="mb-2 text-[13px] font-semibold">
              {t('gscTab.inspectDialogTitle', { defaultValue: 'URL Inspection' })}
            </div>
            <div className="mb-3 text-surface-300">
              {inspectDialog.plan
                ? t('gscTab.confirmInspectPlan', {
                    defaultValue:
                      "{{n}} will be inspected, {{m}} inspected in the last 24 hours are skipped; this uses {{n}} of the property's 2 000 a day.",
                    n: inspectDialog.plan.toInspect,
                    m: inspectDialog.plan.skipped,
                  })
                : t('gscTab.loading', { defaultValue: 'Loading…' })}
            </div>
            {(inspectDialog.force || (inspectDialog.plan?.skipped ?? 0) > 0) && (
              <label className="mb-3 flex items-center gap-2 text-surface-300">
                <input
                  type="checkbox"
                  checked={inspectDialog.force}
                  onChange={(e) =>
                    setInspectDialog((d) => (d ? { ...d, force: e.target.checked, plan: null } : d))
                  }
                />
                {t('gscTab.reinspectRecent', {
                  defaultValue: 'Re-inspect pages checked in the last 24 hours',
                })}
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setInspectDialog(null)}
                className="h-6 rounded border border-surface-700 bg-surface-800 px-2.5 text-[11px] hover:bg-surface-700"
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                type="button"
                onClick={() => void runInspect()}
                disabled={!inspectDialog.plan || inspectDialog.plan.toInspect === 0}
                className="h-6 rounded bg-blue-600 px-2.5 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-surface-700 disabled:text-surface-500"
              >
                {t('gscTab.inspectGo', { defaultValue: 'Inspect' })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Column header */}
      <div
        className="flex shrink-0 select-none items-center border-b border-surface-800 bg-surface-900/60 text-[10px] font-medium text-surface-400"
        style={{ height: HEADER_HEIGHT }}
      >
        <div className="flex-1 px-2">{t('gscTab.colUrl', { defaultValue: 'URL' })}</div>
        <div className="w-[54px] shrink-0 text-center">
          {t('gscTab.colStatus', { defaultValue: 'Status' })}
        </div>
        <div className="flex w-[64px] shrink-0 items-center justify-center gap-1">
          {t('gscTab.colVerdict', { defaultValue: 'Index' })}
          <InfoTip
            info={
              'Google\'s index status, pulled from the URL Inspection API — not the Fetch button. Click "Inspect (top 100)" to fill this column; Fetch only pulls clicks / impressions / position.'
            }
            example={
              'PASS = indexed · FAIL = not indexed · PART/NEU = discovered but not yet indexed'
            }
          />
        </div>
        <div
          className="w-[64px] shrink-0 text-right"
          title={t('gscTab.colSitemapsTip', {
            defaultValue: 'Sitemaps Google lists for this page; not a complete list',
          })}
        >
          {t('gscTab.colSitemaps', { defaultValue: 'Sitemaps' })}
        </div>
        <div className="w-[76px] shrink-0 text-right">
          {t('gscTab.colLinkedFrom', { defaultValue: 'Linked from' })}
        </div>
        <div className="w-[130px] shrink-0 px-2">
          {t('gscTab.colRich', { defaultValue: 'Rich results' })}
        </div>
        <div className="w-[72px] shrink-0 text-right">
          {t('gscTab.colClicks', { defaultValue: 'Clicks' })}
        </div>
        <div className="w-[92px] shrink-0 text-right">
          {t('gscTab.colImpr', { defaultValue: 'Impressions' })}
        </div>
        <div className="w-[64px] shrink-0 text-right">
          {t('gscTab.colCtr', { defaultValue: 'CTR' })}
        </div>
        <div className="w-[72px] shrink-0 text-right">
          {t('gscTab.colPos', { defaultValue: 'Position' })}
        </div>
        <div className="w-[88px] shrink-0 px-2 text-right">
          {t('gscTab.colFetched', { defaultValue: 'Fetched' })}
        </div>
      </div>

      {/* Body */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-surface-500">
            {total === 0
              ? t('gscTab.emptyNoData', {
                  defaultValue:
                    'No internal HTML pages crawled yet — run a crawl, then fetch Search Console data.',
                })
              : t('gscTab.emptyNoMatch', {
                  defaultValue: 'No pages match the current filter.',
                })}
          </div>
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((vRow) => {
              const row = rows[vRow.index];
              if (!row) return null;
              return (
                <div
                  key={vRow.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: ROW_HEIGHT,
                    transform: `translateY(${vRow.start}px)`,
                  }}
                >
                  <GscDataRow
                    row={row}
                    active={row.id !== null && selectedUrlId === row.id}
                    onSelect={() => {
                      // A GSC URL the crawl never reached has no page to open.
                      if (row.id === null) return;
                      setSelectedUrlId(row.id);
                      setSelectedUrlIds([row.id]);
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div
        className="flex items-center gap-3 border-t border-surface-800 bg-surface-900/40 px-3 text-[11px] text-surface-400"
        style={{ height: STATUS_BAR_HEIGHT }}
      >
        <span>
          {t('gscTab.summary', {
            defaultValue: '{{shown}} pages',
            shown: rows.length.toLocaleString(),
          })}
          {total > rows.length &&
            ' ' +
              t('gscTab.firstN', {
                defaultValue: '(first {{n}})',
                n: PAGE_SIZE.toLocaleString(),
              })}
        </span>
        {fetching && (
          <span className="flex items-center gap-1.5 text-surface-500">
            <Loader2 size={11} className="animate-spin text-blue-400" />
            {t('gscTab.fetching', { defaultValue: 'Fetching from Search Console…' })}
          </span>
        )}
      </div>
    </div>
  );
}

function GscDataRow({
  row,
  active,
  onSelect,
}: {
  row: GscRow;
  /** The page the Detail panel is showing. */
  active: boolean;
  onSelect: () => void;
}) {
  const g = row.gsc;
  const insp = row.inspection;
  const status = row.statusCode;
  const statusCls =
    status === null
      ? 'text-surface-600'
      : status >= 200 && status < 300
        ? 'text-emerald-400'
        : status >= 300 && status < 400
          ? 'text-blue-400'
          : 'text-red-400';

  return (
    <div
      onClick={onSelect}
      className={`flex h-full items-center text-[11px] ${row.id !== null ? 'cursor-pointer' : ''} ${
        active ? 'bg-accent-500/20' : 'odd:bg-surface-900/20 hover:bg-surface-800/40'
      }`}
    >
      <div className="flex-1 truncate px-2 text-surface-200" title={row.url}>
        {row.url}
      </div>
      <div className={`w-[54px] shrink-0 text-center tabular-nums ${statusCls}`}>
        {status ?? '—'}
      </div>
      <div className="w-[64px] shrink-0 text-center">
        <VerdictBadge
          verdict={row.inspection?.verdict ?? null}
          title={row.inspection?.coverageState ?? null}
        />
      </div>
      <div
        className="w-[64px] shrink-0 text-right tabular-nums text-surface-300"
        title={
          insp?.sitemaps && insp.sitemaps.length > 0
            ? `${insp.sitemaps[0]}\n(Sitemaps Google lists for this page; not a complete list)`
            : undefined
        }
      >
        {insp?.sitemaps ? insp.sitemaps.length : ''}
      </div>
      <div className="w-[76px] shrink-0 text-right tabular-nums text-surface-300">
        {insp?.referringCount != null ? insp.referringCount.toLocaleString() : ''}
      </div>
      <div
        className="w-[130px] shrink-0 truncate px-2 text-surface-300"
        title={richSummary(insp?.richResults)}
      >
        {richSummary(insp?.richResults)}
      </div>
      <div className="w-[72px] shrink-0 text-right tabular-nums text-surface-200">
        {g ? g.clicks.toLocaleString() : '—'}
      </div>
      <div className="w-[92px] shrink-0 text-right tabular-nums text-surface-300">
        {g ? g.impressions.toLocaleString() : '—'}
      </div>
      <div className="w-[64px] shrink-0 text-right tabular-nums text-surface-300">
        {g ? `${(g.ctr * 100).toFixed(1)}%` : '—'}
      </div>
      <div
        className={`w-[72px] shrink-0 text-right tabular-nums ${
          g ? positionClass(g.position) : 'text-surface-600'
        }`}
      >
        {g ? g.position.toFixed(1) : '—'}
      </div>
      <div className="w-[88px] shrink-0 truncate px-2 text-right text-surface-500">
        {g ? relativeTime(g.fetchedAt) : '—'}
      </div>
    </div>
  );
}

/** «Product snippets 1E 2W, Breadcrumbs»: each type with its item error / warning counts; empty when not inspected. */
function richSummary(types: GscRichResultType[] | null | undefined): string {
  if (!types) return '';
  return types
    .map((ty) => {
      const e = ty.items.filter((it) => it.errors > 0).length;
      const w = ty.items.filter((it) => it.warnings > 0).length;
      return [ty.type, e > 0 ? `${e}E` : '', w > 0 ? `${w}W` : ''].filter(Boolean).join(' ');
    })
    .join(', ');
}

function VerdictBadge({ verdict, title }: { verdict: string | null; title: string | null }) {
  if (!verdict) return <span className="text-surface-700">—</span>;
  const cls =
    verdict === 'PASS'
      ? 'bg-emerald-900/40 text-emerald-300'
      : verdict === 'PARTIAL' || verdict === 'NEUTRAL'
        ? 'bg-amber-900/40 text-amber-300'
        : 'bg-red-900/40 text-red-300';
  const short =
    verdict === 'PASS'
      ? 'PASS'
      : verdict === 'PARTIAL'
        ? 'PART'
        : verdict === 'NEUTRAL'
          ? 'NEU'
          : verdict === 'FAIL'
            ? 'FAIL'
            : verdict.slice(0, 4);
  return (
    <span
      className={`inline-flex rounded px-1.5 text-[10px] font-semibold ${cls}`}
      title={title ?? verdict}
    >
      {short}
    </span>
  );
}

function GateMessage({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center bg-surface-950 px-6">
      <div className="max-w-md text-center">
        <div className="mb-1.5 text-[13px] font-semibold text-surface-200">{title}</div>
        <div className="text-[11px] leading-relaxed text-surface-500">{body}</div>
        {children}
      </div>
    </div>
  );
}
