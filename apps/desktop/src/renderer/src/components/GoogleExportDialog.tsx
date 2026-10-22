import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportDatasetKey } from '@freecrawl/shared-types';

export type GoogleExportDataset = 'urls' | ExportDatasetKey;

/** Tables offered to Google Sheets / BigQuery: the ones that need no per-account context. */
const DATASETS: GoogleExportDataset[] = [
  'urls',
  'issues-long',
  'broken-links',
  'images',
  'sitemap-urls',
  'response-headers',
  'crawl-queue',
];

const DEFAULT_LABELS: Record<string, string> = {
  urls: 'Pages of the current tab',
  'issues-long': 'Issues (one row per page and issue)',
  'broken-links': 'Broken links',
  images: 'Images',
  'sitemap-urls': 'Sitemap URLs',
  'response-headers': 'Response headers',
  'crawl-queue': 'Crawl queue',
};

interface GoogleExportDialogProps {
  target: 'sheets' | 'bigquery' | null;
  onConfirm: (dataset: GoogleExportDataset) => void;
  onCancel: () => void;
}

/** Picks the table a Google Sheets / BigQuery export writes: one table per run. */
export function GoogleExportDialog({
  target,
  onConfirm,
  onCancel,
}: GoogleExportDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const [dataset, setDataset] = useState<GoogleExportDataset>('urls');

  useEffect(() => {
    if (target) setDataset('urls');
  }, [target]);

  if (!target) return null;

  const title =
    target === 'sheets'
      ? t('googleExport.titleSheets', { defaultValue: 'Export to Google Sheets' })
      : t('googleExport.titleBigquery', { defaultValue: 'Export to BigQuery' });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="w-[420px] rounded-md border border-surface-700 bg-surface-900 p-5 text-surface-100 shadow-xl"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 className="mb-3 text-[15px] font-semibold">{title}</h2>
        <label className="mb-1 block text-[11px] font-medium text-surface-300">
          {t('googleExport.tableLabel', { defaultValue: 'Table to export' })}
        </label>
        <select
          className="w-full rounded border border-surface-700 bg-surface-950 px-2 py-1.5 text-[12px] outline-none focus:border-blue-500"
          value={dataset}
          onChange={(e) => setDataset(e.target.value as GoogleExportDataset)}
        >
          {DATASETS.map((key) => (
            <option key={key} value={key}>
              {t(`googleExport.dataset.${key}`, { defaultValue: DEFAULT_LABELS[key] })}
            </option>
          ))}
        </select>
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
            className="rounded bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-500"
            onClick={() => onConfirm(dataset)}
          >
            {t('export.exportButton', { defaultValue: 'Export' })}
          </button>
        </div>
      </div>
    </div>
  );
}
