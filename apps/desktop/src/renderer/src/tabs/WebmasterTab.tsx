import { useCallback, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import {
  webmasterReasonFallback,
  type WebmasterBrokenPreset,
  type WebmasterBrokenRow,
  type WebmasterErrorCode,
  type WebmasterExcludedPreset,
  type WebmasterExcludedRow,
  type WebmasterFetchMeta,
  type WebmasterHost,
  type WebmasterProgress,
} from '@freecrawl/shared-types';
import { TabExportButton } from '../components/TabExportButton.js';
import { useAppStore } from '../store.js';

const TOOLBAR_HEIGHT = 36;
const HEADER_HEIGHT = 26;
const STATUS_BAR_HEIGHT = 22;
const ROW_HEIGHT = 30;
const PAGE_SIZE = 1000;

type View = 'excluded' | 'broken';
type Stage = 'loading' | 'unconfigured' | 'ready' | 'error';
type T = ReturnType<typeof useTranslation>['t'];

// Latest progress kept outside the component so a pull that is still running
// when the user leaves the tab and comes back shows up at once.
let lastProgress: WebmasterProgress | null = null;
const progressListeners = new Set<(p: WebmasterProgress | null) => void>();
let progressSubscribed = false;
function subscribeProgress(cb: (p: WebmasterProgress | null) => void): () => void {
  if (!progressSubscribed) {
    progressSubscribed = true;
    window.freecrawl.onWebmasterProgress((p) => {
      lastProgress = p.running ? p : null;
      for (const l of progressListeners) l(lastProgress);
    });
  }
  progressListeners.add(cb);
  return () => {
    progressListeners.delete(cb);
  };
}

function dayOf(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

export function WebmasterTab() {
  const { t } = useTranslation();
  const dataVersion = useAppStore((s) => s.dataVersion);
  const selectedUrlId = useAppStore((s) => s.selectedUrlId);
  const setSelectedUrlId = useAppStore((s) => s.setSelectedUrlId);
  const setSelectedUrlIds = useAppStore((s) => s.setSelectedUrlIds);

  const [stage, setStage] = useState<Stage>('loading');
  const [hosts, setHosts] = useState<WebmasterHost[]>([]);
  const [hostId, setHostId] = useState('');
  const [view, setView] = useState<View>('excluded');
  const [excludedPreset, setExcludedPreset] = useState<WebmasterExcludedPreset>('all');
  const [brokenPreset, setBrokenPreset] = useState<WebmasterBrokenPreset>('all');
  const [search, setSearch] = useState('');
  const [excluded, setExcluded] = useState<WebmasterExcludedRow[]>([]);
  const [broken, setBroken] = useState<WebmasterBrokenRow[]>([]);
  const [total, setTotal] = useState(0);
  const [meta, setMeta] = useState<WebmasterFetchMeta | null>(null);
  const [progress, setProgress] = useState<WebmasterProgress | null>(lastProgress);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<WebmasterErrorCode | null>(null);
  const [exceededUntil, setExceededUntil] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fetching = progress !== null;

  const showError = useCallback(
    (text: string | null, code: WebmasterErrorCode | null = null, until: string | null = null) => {
      setError(text);
      setErrorCode(code);
      setExceededUntil(until);
    },
    [],
  );

  const loadHosts = useCallback(async () => {
    const res = await window.freecrawl.webmasterListHosts();
    if (!res.ok) {
      showError(res.error, res.errorCode);
      setHosts([]);
      return;
    }
    showError(null);
    setHosts(res.hosts);
    const keep = res.hosts.some((h) => h.hostId === res.savedHostId);
    setHostId(keep ? res.savedHostId : (res.hosts[0]?.hostId ?? ''));
  }, [showError]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const integrations = await window.freecrawl.integrationsGetAll();
        if (cancelled) return;
        if (!(integrations['webmaster']?.configured ?? false)) {
          setStage('unconfigured');
          return;
        }
        setStage('ready');
        await loadHosts();
      } catch (e) {
        if (cancelled) return;
        showError(e instanceof Error ? e.message : String(e));
        setStage('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadHosts, retryNonce, showError]);

  // Queries run on a reader pool and can finish out of order; only the latest fills the table.
  const reloadSeq = useRef(0);
  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    const base = {
      limit: PAGE_SIZE,
      offset: 0,
      search: search || undefined,
      hostId: hostId || undefined,
    };
    if (view === 'excluded') {
      const res = await window.freecrawl.webmasterQueryExcluded({
        ...base,
        preset: excludedPreset,
      });
      if (seq !== reloadSeq.current) return;
      setExcluded(res.rows);
      setBroken([]);
      setTotal(res.total);
      setMeta(res.meta);
    } else {
      const res = await window.freecrawl.webmasterQueryBroken({ ...base, preset: brokenPreset });
      if (seq !== reloadSeq.current) return;
      setBroken(res.rows);
      setExcluded([]);
      setTotal(res.total);
      setMeta(res.meta);
    }
  }, [view, excludedPreset, brokenPreset, search, hostId]);

  useEffect(() => {
    if (stage !== 'ready') return;
    void reload();
  }, [stage, reload, dataVersion]);

  useEffect(() => subscribeProgress(setProgress), []);

  const rowCount = view === 'excluded' ? excluded.length : broken.length;
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });

  const runFetch = useCallback(async () => {
    if (!hostId || fetching) return;
    const host = hosts.find((h) => h.hostId === hostId);
    showError(null);
    setInfo(null);
    setProgress({ running: true, phase: 'events', done: 0, total: 0 });
    try {
      const res = await window.freecrawl.webmasterFetch({
        hostId,
        hostName: host?.hostName ?? hostId,
      });
      if (res.cancelled) {
        setInfo(
          t('webmasterTab.cancelled', {
            defaultValue:
              'Fetch stopped. Pages already saved are kept and the next fetch continues from there.',
          }),
        );
      } else if (!res.ok) {
        showError(res.error, res.errorCode, res.exceededUntil);
      } else {
        setMeta(res.meta);
      }
    } finally {
      setProgress(lastProgress);
      await reload();
    }
  }, [hostId, hosts, fetching, reload, showError, t]);

  const errorText = (): string | null => {
    switch (errorCode) {
      case 'not-connected':
        return t('webmasterTab.errNotConnected', {
          defaultValue:
            'Yandex Webmaster is not connected — paste a token in Settings → Integrations → Yandex Webmaster.',
        });
      case 'token-format':
        return t('webmasterTab.errTokenFormat', {
          defaultValue:
            'The saved Yandex Webmaster token has an unexpected format — paste it again in Settings → Integrations → Yandex Webmaster.',
        });
      case 'token-rejected':
        return t('webmasterTab.errTokenRejected', {
          defaultValue:
            'Yandex Webmaster rejected the token — paste a fresh token in Settings → Integrations → Yandex Webmaster.',
        });
      case 'access-denied':
        return t('webmasterTab.errAccessDenied', {
          defaultValue:
            'Yandex Webmaster denied access — the token needs the webmaster:hostinfo and webmaster:verify permissions.',
        });
      case 'quota-exceeded':
        return t('webmasterTab.errQuota', {
          defaultValue:
            'Yandex Webmaster daily quota is used up. Progress is saved; fetch again after {{until}} to continue.',
          until: exceededUntil ? exceededUntil.replace('T', ' ').slice(0, 16) + ' UTC' : '—',
        });
      case 'host-not-verified':
        return t('webmasterTab.errHostNotVerified', {
          defaultValue:
            'This site is not verified in Yandex Webmaster, so Yandex gives no data for it.',
        });
      case 'invalid-user':
        return t('webmasterTab.errInvalidUser', {
          defaultValue: 'Yandex Webmaster did not accept the account behind the token.',
        });
      case 'network':
        return t('webmasterTab.errNetwork', {
          defaultValue:
            'Could not reach Yandex Webmaster. Check the connection and try again; saved progress is kept.',
        });
      default:
        return null;
    }
  };

  const reasonLabel = (reason: string | null): string =>
    reason
      ? t(`webmasterTab.reason.${reason}`, { defaultValue: webmasterReasonFallback(reason) })
      : '—';

  if (stage === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-surface-950 text-[12px] text-surface-500">
        <Loader2 size={14} className="mr-2 animate-spin" />
        {t('webmasterTab.loading', { defaultValue: 'Loading…' })}
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
            showError(null);
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
      <div className="flex h-full items-center justify-center bg-surface-950 px-6">
        <div className="max-w-md text-center">
          <div className="mb-1.5 text-[13px] font-semibold text-surface-200">
            {t('webmasterTab.unconfiguredTitle', {
              defaultValue: 'Yandex Webmaster is not set up',
            })}
          </div>
          <div className="text-[11px] leading-relaxed text-surface-500">
            {t('webmasterTab.unconfiguredBody', {
              defaultValue:
                'Open Settings → Integrations → Yandex Webmaster and paste a token with the webmaster:hostinfo and webmaster:verify permissions. Then come back here to pick a site.',
            })}
          </div>
        </div>
      </div>
    );
  }

  const selectCls =
    'h-6 rounded border border-surface-700 bg-surface-950 px-1.5 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none';
  const progressText = progress
    ? t(
        progress.phase === 'events' ? 'webmasterTab.progressEvents' : 'webmasterTab.progressLinks',
        {
          defaultValue:
            progress.phase === 'events'
              ? 'Fetching Yandex search events · {{done}} / {{total}}'
              : 'Fetching broken links · {{done}} / {{total}}',
          done: progress.done.toLocaleString(),
          total: progress.total.toLocaleString(),
        },
      )
    : null;

  return (
    <div className="flex h-full w-full flex-col bg-surface-950">
      <div
        className="flex items-center gap-2 border-b border-surface-800 bg-surface-900/40 px-3"
        style={{ height: TOOLBAR_HEIGHT }}
      >
        <div className="text-[12px] font-semibold tracking-wide text-surface-100">
          {t('webmasterTab.title', { defaultValue: 'Yandex Webmaster' })}
        </div>
        <select
          className={selectCls}
          value={view}
          onChange={(e) => setView(e.target.value as View)}
        >
          <option value="excluded">
            {t('webmasterTab.viewExcluded', { defaultValue: 'Excluded pages' })}
          </option>
          <option value="broken">
            {t('webmasterTab.viewBroken', { defaultValue: 'Broken internal links' })}
          </option>
        </select>
        {view === 'excluded' ? (
          <select
            className={selectCls}
            value={excludedPreset}
            onChange={(e) => setExcludedPreset(e.target.value as WebmasterExcludedPreset)}
          >
            <option value="all">{t('webmasterTab.presetAll', { defaultValue: 'All' })}</option>
            <option value="indexable-in-crawl">
              {t('webmasterTab.presetIndexable', { defaultValue: 'Indexable in my crawl' })}
            </option>
            <option value="not-in-crawl">
              {t('webmasterTab.presetNotInCrawl', { defaultValue: 'Not in my crawl' })}
            </option>
          </select>
        ) : (
          <select
            className={selectCls}
            value={brokenPreset}
            onChange={(e) => setBrokenPreset(e.target.value as WebmasterBrokenPreset)}
          >
            <option value="all">{t('webmasterTab.presetAll', { defaultValue: 'All' })}</option>
            <option value="not-seen-by-crawl">
              {t('webmasterTab.presetNotSeen', { defaultValue: 'Not seen by my crawl' })}
            </option>
          </select>
        )}
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-surface-500"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('webmasterTab.filterPlaceholder', { defaultValue: 'Filter by URL…' })}
            className="h-6 w-48 rounded border border-surface-700 bg-surface-950 pl-6 pr-2 text-[11px] text-surface-100 placeholder-surface-500 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <TabExportButton
            tab="webmaster"
            defaultLeaf={view === 'excluded' ? 'excluded' : 'broken-links'}
            disabled={total === 0}
          />
          <select
            className={`${selectCls} max-w-[260px]`}
            value={hostId}
            onChange={(e) => setHostId(e.target.value)}
            disabled={fetching || hosts.length === 0}
            title={hostId}
          >
            {hosts.length === 0 && (
              <option value="">{t('webmasterTab.noHosts', { defaultValue: 'No sites' })}</option>
            )}
            {hosts.map((h) => (
              <option key={h.hostId} value={h.hostId}>
                {h.hostName}
                {h.verified
                  ? ''
                  : ` (${t('webmasterTab.notVerified', { defaultValue: 'not verified' })})`}
              </option>
            ))}
          </select>
          {fetching ? (
            <button
              type="button"
              onClick={() => void window.freecrawl.webmasterCancel()}
              className="h-6 rounded border border-red-700 bg-red-900/40 px-2.5 text-[11px] font-medium text-red-200 hover:bg-red-900/70"
            >
              {t('webmasterTab.cancel', { defaultValue: 'Cancel' })}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void runFetch()}
              disabled={!hostId}
              className="inline-flex h-6 items-center gap-1.5 rounded bg-blue-600 px-2.5 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-surface-700 disabled:text-surface-500"
            >
              <RefreshCw size={12} />
              {t('webmasterTab.fetch', { defaultValue: 'Fetch' })}
            </button>
          )}
        </div>
      </div>

      {meta && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-surface-800 bg-surface-900/20 px-3 py-1 text-[10px] text-surface-500">
          <span>
            {t('webmasterTab.metaLine', {
              defaultValue:
                '{{host}} · {{events}} pages removed from search · {{links}} broken links · fetched {{when}}',
              host: meta.hostName,
              // meta.eventRows counts appearances too; only a store from before excludedRows lacks the right number.
              events: (meta.excludedRows ?? meta.eventRows).toLocaleString(),
              links: meta.brokenLinkRows.toLocaleString(),
              when: dayOf(meta.fetchedAt),
            })}
          </span>
          {meta.truncatedAtCap && (
            <span className="text-amber-400">
              {t('webmasterTab.truncatedFlag', {
                defaultValue: 'Row limit reached: the lists are cut short',
              })}
            </span>
          )}
        </div>
      )}
      {error && (
        <div className="border-b border-red-700/40 bg-red-900/20 px-3 py-1 text-[10px] text-red-300">
          {errorText() ?? error}
        </div>
      )}
      {info && (
        <div className="border-b border-surface-800 bg-surface-900/20 px-3 py-1 text-[10px] text-surface-400">
          {info}
        </div>
      )}

      {view === 'excluded' && (
        <div className="border-b border-surface-800 bg-surface-900/20 px-3 py-1 text-[10px] text-surface-500">
          {t('webmasterTab.excludedNote', {
            defaultValue:
              'Pages Yandex removed from search (latest event per page). This is not the full list of excluded pages: a page whose latest event is a return to search is not shown here.',
          })}
        </div>
      )}
      <div
        className="flex shrink-0 select-none items-center border-b border-surface-800 bg-surface-900/60 text-[10px] font-medium text-surface-400"
        style={{ height: HEADER_HEIGHT }}
      >
        {view === 'excluded' ? (
          <>
            <div className="flex-1 px-2">{t('webmasterTab.colUrl', { defaultValue: 'URL' })}</div>
            <div className="w-[200px] shrink-0">
              {t('webmasterTab.colReason', { defaultValue: 'Reason' })}
            </div>
            <div className="w-[80px] shrink-0 text-center">
              {t('webmasterTab.colHttp', { defaultValue: 'HTTP status (Yandex)' })}
            </div>
            <div className="w-[200px] shrink-0 px-2">
              {t('webmasterTab.colTarget', { defaultValue: 'Yandex target' })}
            </div>
            <div className="w-[96px] shrink-0 text-right">
              {t('webmasterTab.colEventDate', { defaultValue: 'Excluded on' })}
            </div>
            <div className="w-[96px] shrink-0 text-right">
              {t('webmasterTab.colLastAccess', { defaultValue: 'Last visit' })}
            </div>
            <div className="w-[80px] shrink-0 text-center">
              {t('webmasterTab.colCrawlStatus', { defaultValue: 'Crawl status' })}
            </div>
            <div className="w-[110px] shrink-0 px-2">
              {t('webmasterTab.colCrawlIndex', { defaultValue: 'Crawl indexability' })}
            </div>
          </>
        ) : (
          <>
            <div className="flex-1 px-2">
              {t('webmasterTab.colSource', { defaultValue: 'Source page' })}
            </div>
            <div className="flex-1 px-2">
              {t('webmasterTab.colDestination', { defaultValue: 'Broken link target' })}
            </div>
            <div className="w-[96px] shrink-0 text-right">
              {t('webmasterTab.colDiscovered', { defaultValue: 'Found on' })}
            </div>
            <div className="w-[80px] shrink-0 text-center">
              {t('webmasterTab.colTargetStatus', { defaultValue: 'Crawl status' })}
            </div>
            <div className="w-[110px] shrink-0 px-2">
              {t('webmasterTab.colSeen', { defaultValue: 'Seen by crawl' })}
            </div>
          </>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {rowCount === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-surface-500">
            {!meta && !search
              ? t('webmasterTab.emptyNoPull', {
                  defaultValue:
                    'No Yandex Webmaster data has been fetched for this site yet. Press Fetch.',
                })
              : t('webmasterTab.emptyNoMatch', {
                  defaultValue: 'No rows match the current filter.',
                })}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const style = {
                position: 'absolute' as const,
                top: 0,
                left: 0,
                width: '100%',
                height: ROW_HEIGHT,
                transform: `translateY(${v.start}px)`,
              };
              if (view === 'excluded') {
                const row = excluded[v.index];
                if (!row) return null;
                return (
                  <div key={v.key} style={style}>
                    <ExcludedRow
                      row={row}
                      reason={reasonLabel(row.reason)}
                      active={row.id !== null && selectedUrlId === row.id}
                      notInCrawl={t('webmasterTab.notInCrawl', { defaultValue: 'not in crawl' })}
                      onSelect={() => {
                        if (row.id === null) return;
                        setSelectedUrlId(row.id);
                        setSelectedUrlIds([row.id]);
                      }}
                    />
                  </div>
                );
              }
              const row = broken[v.index];
              if (!row) return null;
              return (
                <div key={v.key} style={style}>
                  <BrokenRow row={row} t={t} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div
        className="flex items-center gap-3 border-t border-surface-800 bg-surface-900/40 px-3 text-[11px] text-surface-400"
        style={{ height: STATUS_BAR_HEIGHT }}
      >
        <span>
          {t('webmasterTab.summary', {
            defaultValue: '{{shown}} of {{formatted}}',
            shown: rowCount.toLocaleString(),
            formatted: total.toLocaleString(),
          })}
        </span>
        {progressText && (
          <span className="flex items-center gap-1.5 text-surface-500">
            <Loader2 size={11} className="animate-spin text-blue-400" />
            {progressText}
          </span>
        )}
      </div>
    </div>
  );
}

function ExcludedRow({
  row,
  reason,
  active,
  notInCrawl,
  onSelect,
}: {
  row: WebmasterExcludedRow;
  reason: string;
  active: boolean;
  notInCrawl: string;
  onSelect: () => void;
}) {
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
      <div className="w-[200px] shrink-0 truncate text-surface-300" title={reason}>
        {reason}
      </div>
      <div className="w-[80px] shrink-0 text-center tabular-nums text-surface-300">
        {row.badHttpStatus ?? '—'}
      </div>
      <div className="w-[200px] shrink-0 truncate px-2 text-surface-300" title={row.targetUrl ?? undefined}>
        {row.targetUrl ?? '—'}
      </div>
      <div className="w-[96px] shrink-0 text-right tabular-nums text-surface-300">
        {dayOf(row.eventDate)}
      </div>
      <div className="w-[96px] shrink-0 text-right tabular-nums text-surface-500">
        {dayOf(row.lastAccess)}
      </div>
      <div className="w-[80px] shrink-0 text-center tabular-nums text-surface-300">
        {row.id === null ? '—' : (row.crawlStatusCode ?? '—')}
      </div>
      <div className="w-[110px] shrink-0 truncate px-2 text-surface-400">
        {row.id === null ? notInCrawl : (row.crawlIndexability ?? '—')}
      </div>
    </div>
  );
}

function BrokenRow({ row, t }: { row: WebmasterBrokenRow; t: T }) {
  return (
    <div className="flex h-full items-center text-[11px] odd:bg-surface-900/20 hover:bg-surface-800/40">
      <div className="flex-1 truncate px-2 text-surface-200" title={row.sourceUrl}>
        {row.sourceUrl}
      </div>
      <div className="flex-1 truncate px-2 text-surface-200" title={row.destinationUrl}>
        {row.destinationUrl}
      </div>
      <div className="w-[96px] shrink-0 text-right tabular-nums text-surface-300">
        {dayOf(row.discoveryDate)}
      </div>
      <div className="w-[80px] shrink-0 text-center tabular-nums text-surface-300">
        {row.destinationStatusCode ?? '—'}
      </div>
      <div className="w-[110px] shrink-0 px-2 text-surface-400">
        {row.seenByCrawl
          ? t('webmasterTab.seenYes', { defaultValue: 'yes' })
          : t('webmasterTab.seenNo', { defaultValue: 'no' })}
      </div>
    </div>
  );
}
