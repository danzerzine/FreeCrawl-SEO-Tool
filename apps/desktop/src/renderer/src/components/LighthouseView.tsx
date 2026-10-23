import { Fragment, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Monitor, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  formatKb,
  formatSavingsMs,
  orderForView,
  resourceLine,
  type PagespeedAuditKind,
  type PagespeedAuditRow,
  type PagespeedStrategy,
} from '@freecrawl/shared-types';
import { useAppStore } from '../store.js';

/** Enough for every audit one page can have (about 30 per device). */
const AUDITS_LIMIT = 1000;

const KIND_CLASS: Record<PagespeedAuditKind, string> = {
  opportunity: 'border-blue-800 bg-blue-900/40 text-blue-300',
  insight: 'border-violet-800 bg-violet-900/40 text-violet-300',
  diagnostic: 'border-surface-700 bg-surface-800 text-surface-300',
};

/**
 * Lighthouse sub-tab of the detail panel: the stored PageSpeed insights, opportunities and
 * diagnostics of the selected page, for one device at a time. A row opens to the affected
 * resources Lighthouse named. The savings are Lighthouse's estimates and overlap.
 */
export function LighthouseView({ pageUrl }: { pageUrl: string }) {
  const { t } = useTranslation();
  const dataVersion = useAppStore((s) => s.dataVersion);
  const [rows, setRows] = useState<PagespeedAuditRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<PagespeedStrategy>('mobile');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setLoadError(null);
    setOpen(null);
    void window.freecrawl
      .pagespeedAuditsQuery({ url: pageUrl, limit: AUDITS_LIMIT, offset: 0 })
      .then((res) => {
        if (!cancelled) setRows(res.rows);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
        setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pageUrl, dataVersion]);

  const shown = useMemo(() => (rows ? orderForView(rows, strategy) : []), [rows, strategy]);
  const first = shown[0];

  if (rows === null) {
    return (
      <div className="p-3 text-[11px] text-surface-500">
        {t('detail.lighthouse.loading', { defaultValue: 'Loading…' })}
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="p-3 text-[11px]">
        <div className="font-semibold text-rose-300">
          {t('common.loadFailedTitle', { defaultValue: "Couldn't load this view" })}
        </div>
        <div className="mt-0.5 break-words text-surface-500">{loadError}</div>
      </div>
    );
  }

  const kindLabel = (k: PagespeedAuditKind): string =>
    k === 'opportunity'
      ? t('detail.lighthouse.kindOpportunity', { defaultValue: 'Opportunity' })
      : k === 'insight'
        ? t('detail.lighthouse.kindInsight', { defaultValue: 'Insight' })
        : t('detail.lighthouse.kindDiagnostic', { defaultValue: 'Diagnostic' });

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-[28px] shrink-0 items-center gap-3 border-b border-surface-800 bg-surface-900 px-3 py-1 text-[11px] text-surface-500">
        {(['mobile', 'desktop'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setStrategy(s);
              setOpen(null);
            }}
            className={clsx(
              'flex items-center gap-1 rounded border px-2 py-0.5 text-[10px]',
              strategy === s
                ? 'border-blue-600 bg-blue-900/40 text-blue-200'
                : 'border-surface-700 text-surface-400 hover:bg-surface-800',
            )}
          >
            {s === 'mobile' ? <Smartphone size={11} /> : <Monitor size={11} />}
            {s === 'mobile'
              ? t('pagespeedTab.deviceMobile', { defaultValue: 'Mobile' })
              : t('pagespeedTab.deviceDesktop', { defaultValue: 'Desktop' })}
          </button>
        ))}
        {first && (
          <span className="truncate">
            {t('detail.lighthouse.version', {
              defaultValue: 'Lighthouse {{version}}, fetched {{date}}',
              version: first.lighthouseVersion ?? '?',
              date: new Date(first.fetchedAt).toLocaleString(),
            })}
          </span>
        )}
        <span className="ml-auto truncate">
          {t('pagespeedTab.savingsOverlap', {
            defaultValue: 'Savings overlap; do not add them up.',
          })}
        </span>
      </div>
      {shown.length === 0 ? (
        <div className="p-3 text-[11px] text-surface-500">
          {t('detail.lighthouse.empty', {
            defaultValue: 'No Lighthouse data for this page. Run PageSpeed from the PageSpeed tab.',
          })}
          <div className="mt-1 text-surface-600">
            {t('pagespeedTab.rerunHint', {
              defaultValue: 'Re-run to see opportunities for pages tested before.',
            })}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-[11px]">
            <thead className="sticky top-0 bg-surface-900 text-left text-[10px] font-medium text-surface-400">
              <tr>
                <th className="px-3 py-1">
                  {t('detail.lighthouse.colAudit', { defaultValue: 'Audit' })}
                </th>
                <th className="w-[110px] px-2 py-1 text-right">
                  {t('detail.lighthouse.colSavingsMs', { defaultValue: 'Est. savings (ms)' })}
                </th>
                <th className="w-[110px] px-2 py-1 text-right">
                  {t('detail.lighthouse.colSavingsKb', { defaultValue: 'Est. savings (KB)' })}
                </th>
                <th className="w-[220px] px-2 py-1">
                  {t('detail.lighthouse.colValue', { defaultValue: 'Value' })}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const isOpen = open === r.auditId;
                return (
                  <Fragment key={r.auditId}>
                    <tr
                      onClick={() => setOpen(isOpen ? null : r.auditId)}
                      className="cursor-pointer border-b border-surface-900 odd:bg-surface-900/20 hover:bg-surface-800/40"
                      aria-expanded={isOpen}
                    >
                      <td className="px-3 py-1 text-surface-200">
                        <span className="mr-1 text-surface-500">{isOpen ? '▾' : '▸'}</span>
                        <span
                          className={clsx(
                            'mr-2 rounded border px-1 py-px text-[9px]',
                            KIND_CLASS[r.kind],
                          )}
                        >
                          {kindLabel(r.kind)}
                        </span>
                        <span title={r.auditId}>{r.title}</span>
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-surface-300">
                        {formatSavingsMs(r.savingsMs)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-surface-300">
                        {formatKb(r.savingsBytes)}
                      </td>
                      <td
                        className="truncate px-2 py-1 text-surface-400"
                        title={r.displayValue ?? undefined}
                      >
                        {r.displayValue ?? ''}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-surface-900 bg-surface-950/40">
                        <td colSpan={4} className="px-8 py-1.5 text-[10.5px] text-surface-300">
                          {r.items.length === 0 ? (
                            <span className="text-surface-500">
                              {t('detail.lighthouse.noResources', {
                                defaultValue: 'Lighthouse lists no resources for this audit.',
                              })}
                            </span>
                          ) : (
                            <ul className="space-y-0.5">
                              {r.items.map((it, i) => (
                                <li key={i} className="break-all">
                                  {resourceLine(it)}
                                </li>
                              ))}
                            </ul>
                          )}
                          {r.itemsTruncated && (
                            <div className="mt-1 text-surface-500">
                              {t('detail.lighthouse.truncated', {
                                defaultValue:
                                  'Showing the first {{n}} resources; the rest were cut.',
                                n: r.items.length,
                              })}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
