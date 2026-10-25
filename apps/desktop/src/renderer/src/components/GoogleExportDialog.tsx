import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { GoogleExportDataset } from '@freecrawl/shared-types';

export type { GoogleExportDataset };

/** Tables offered to Google Sheets / BigQuery: the ones that need no per-account context. */
const DATASETS: GoogleExportDataset[] = [
  'urls',
  'links',
  'issues-long',
  'broken-links',
  'images',
  'sitemap-urls',
  'response-headers',
  'crawl-queue',
];

const DEFAULT_LABELS: Record<string, string> = {
  urls: 'Pages of the current tab',
  links: 'All links (internal and external)',
  'issues-long': 'Issues (one row per page and issue)',
  'broken-links': 'Broken links',
  images: 'Images',
  'sitemap-urls': 'Sitemap URLs',
  'response-headers': 'Response headers',
  'crawl-queue': 'Crawl queue',
};

interface GoogleExportDialogProps {
  target: 'sheets' | 'bigquery' | null;
  onConfirm: (datasets: GoogleExportDataset[]) => void;
  onCancel: () => void;
}

/** Picks the tables a Google Sheets / BigQuery export writes: one tab or table each (B156). */
export function GoogleExportDialog({
  target,
  onConfirm,
  onCancel,
}: GoogleExportDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<ReadonlySet<GoogleExportDataset>>(new Set(['urls']));

  useEffect(() => {
    if (target) setChosen(new Set(['urls']));
  }, [target]);

  // Escape closes the dialog wherever the focus is: the dialog never takes focus itself.
  useEffect(() => {
    if (!target) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [target, onCancel]);

  if (!target) return null;

  const title =
    target === 'sheets'
      ? t('googleExport.titleSheets', { defaultValue: 'Export to Google Sheets' })
      : t('googleExport.titleBigquery', { defaultValue: 'Export to BigQuery' });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-[420px] rounded-md border border-surface-700 bg-surface-900 p-5 text-surface-100 shadow-xl">
        <h2 className="mb-3 text-[15px] font-semibold">{title}</h2>
        <fieldset>
          <legend className="mb-1 block text-[11px] font-medium text-surface-300">
            {t('googleExport.tablesLabel', { defaultValue: 'Tables to export (one tab or table each)' })}
          </legend>
          {DATASETS.map((key) => (
            <label key={key} className="flex items-center gap-2 py-0.5 text-[12px]">
              <input
                type="checkbox"
                checked={chosen.has(key)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(key);
                  else next.delete(key);
                  setChosen(next);
                }}
              />
              {t(`googleExport.dataset.${key}`, { defaultValue: DEFAULT_LABELS[key] })}
            </label>
          ))}
        </fieldset>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-surface-700 bg-surface-800 px-3 py-1.5 text-[12px] hover:bg-surface-700"
            onClick={onCancel}
          >
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="button"
            className="rounded bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            disabled={chosen.size === 0}
            onClick={() => onConfirm(DATASETS.filter((key) => chosen.has(key)))}
          >
            {t('export.exportButton', { defaultValue: 'Export' })}
          </button>
        </div>
      </div>
    </div>
  );
}
