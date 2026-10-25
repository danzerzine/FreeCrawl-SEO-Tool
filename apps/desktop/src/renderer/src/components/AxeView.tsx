import { Fragment, useEffect, useState } from 'react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { AxeResultRow } from '@freecrawl/shared-types';
import { useAppStore } from '../store.js';

/** Enough for every rule one page can have (the audit stores at most 100). */
const AXE_LIMIT = 200;

const IMPACT_CLASS: Record<string, string> = {
  critical: 'border-rose-800 bg-rose-900/40 text-rose-300',
  serious: 'border-orange-800 bg-orange-900/40 text-orange-300',
  moderate: 'border-amber-800 bg-amber-900/40 text-amber-300',
  minor: 'border-surface-700 bg-surface-800 text-surface-300',
};

/**
 * Accessibility (axe) sub-tab of the detail panel: the stored axe-core rules of the selected
 * page, violations first, then "needs review" (axe could not decide; never an issue). A row
 * opens to the sample elements. Whether the page was audited at all comes from the url row.
 */
export function AxeView({
  pageUrl,
  audited,
}: {
  pageUrl: string;
  /** `axeViolations !== null` on the url row: the page was audited. */
  audited: boolean;
}) {
  const { t } = useTranslation();
  const dataVersion = useAppStore((s) => s.dataVersion);
  const [rows, setRows] = useState<AxeResultRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setLoadError(null);
    setOpen(null);
    void window.freecrawl
      .axeQuery({ url: pageUrl, limit: AXE_LIMIT, offset: 0 })
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

  if (rows === null) {
    return (
      <div className="p-3 text-[11px] text-surface-500">
        {t('detail.axe.loading', { defaultValue: 'Loading…' })}
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

  const impactLabel = (impact: string | null): string => {
    switch (impact) {
      case 'critical':
        return t('detail.axe.impactCritical', { defaultValue: 'Critical' });
      case 'serious':
        return t('detail.axe.impactSerious', { defaultValue: 'Serious' });
      case 'moderate':
        return t('detail.axe.impactModerate', { defaultValue: 'Moderate' });
      case 'minor':
        return t('detail.axe.impactMinor', { defaultValue: 'Minor' });
      default:
        return t('detail.axe.impactNone', { defaultValue: 'No impact' });
    }
  };

  if (rows.length === 0) {
    return (
      <div className="p-3 text-[11px] text-surface-500">
        {audited
          ? t('detail.axe.empty', { defaultValue: 'axe-core found no violations on this page.' })
          : t('detail.axe.notAudited', {
              defaultValue:
                'This page was not audited by axe-core. Turn on the axe-core audit in Settings → Rendering, and crawl again.',
            })}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-[28px] shrink-0 items-center gap-3 border-b border-surface-800 bg-surface-900 px-3 py-1 text-[11px] text-surface-500">
        <span className="truncate">
          {t('detail.axe.version', { defaultValue: 'axe-core, WCAG 2.0-2.2 A/AA' })}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead className="sticky top-0 bg-surface-900 text-left text-[10px] font-medium text-surface-400">
            <tr>
              <th className="w-[130px] whitespace-nowrap px-3 py-1">
                {t('detail.axe.colImpact', { defaultValue: 'Impact' })}
              </th>
              <th className="px-2 py-1">{t('detail.axe.colRule', { defaultValue: 'Rule' })}</th>
              <th className="w-[90px] px-2 py-1 text-right">
                {t('detail.axe.colElements', { defaultValue: 'Elements' })}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const key = `${r.kind}:${r.ruleId}`;
              const isOpen = open === key;
              return (
                <Fragment key={key}>
                  <tr
                    onClick={() => setOpen(isOpen ? null : key)}
                    className="cursor-pointer border-b border-surface-900 odd:bg-surface-900/20 hover:bg-surface-800/40"
                    aria-expanded={isOpen}
                  >
                    <td className="whitespace-nowrap px-3 py-1">
                      <span className="mr-1 text-surface-500">{isOpen ? '▾' : '▸'}</span>
                      <span
                        className={clsx(
                          'rounded border px-1 py-px text-[9px]',
                          IMPACT_CLASS[r.impact ?? ''] ?? IMPACT_CLASS['minor'],
                        )}
                      >
                        {impactLabel(r.impact)}
                      </span>
                      {r.kind === 'incomplete' && (
                        <span className="ml-1 text-[9px] text-surface-500">
                          {t('detail.axe.kindNeedsReview', { defaultValue: 'Needs review' })}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-surface-200">
                      {r.helpUrl ? (
                        <a
                          href={r.helpUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="mr-2 font-mono text-blue-300 hover:underline"
                        >
                          {r.ruleId}
                        </a>
                      ) : (
                        <span className="mr-2 font-mono">{r.ruleId}</span>
                      )}
                      <span>{r.help}</span>
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-surface-300">{r.nodes}</td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-surface-900 bg-surface-950/40">
                      <td colSpan={3} className="px-8 py-1.5 text-[10.5px] text-surface-300">
                        {r.samples.length === 0 ? (
                          <span className="text-surface-500">
                            {t('detail.axe.noSamples', {
                              defaultValue: 'axe-core gave no sample elements for this rule.',
                            })}
                          </span>
                        ) : (
                          <ul className="space-y-1.5">
                            {r.samples.map((s, i) => (
                              <li key={i} className="break-all">
                                <div className="font-mono text-surface-200">{s.target}</div>
                                <div className="font-mono text-surface-400">{s.html}</div>
                                {s.summary && <div className="text-surface-500">{s.summary}</div>}
                              </li>
                            ))}
                          </ul>
                        )}
                        {r.nodes > r.samples.length && (
                          <div className="mt-1 text-surface-500">
                            {t('detail.axe.truncated', {
                              defaultValue: 'Showing {{shown}} of {{n}} elements.',
                              shown: r.samples.length,
                              n: r.nodes,
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
    </div>
  );
}
