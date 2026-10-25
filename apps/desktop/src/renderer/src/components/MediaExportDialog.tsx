import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { MediaExportInfo } from '@freecrawl/shared-types';

const MB = 1024 * 1024;

interface MediaExportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Opens Settings, where the user agent, headers and authentication are changed. */
  onOpenSettings: () => void;
}

/**
 * B154: File → Export PDF Files and Screenshots. The PDF requests are built
 * from the crawl settings (user agent, custom headers, authentication), shown
 * here read-only; the download limit is the project's, so a saved export set
 * or a schedule holding `pdfs` uses the same one.
 */
export function MediaExportDialog({ open, onClose, onOpenSettings }: MediaExportDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const [info, setInfo] = useState<MediaExportInfo | null>(null);
  const [pdfs, setPdfs] = useState(true);
  const [screenshots, setScreenshots] = useState(true);
  const [limitMb, setLimitMb] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setInfo(null);
    setBusy(false);
    void window.freecrawl.exportMediaInfo().then((i) => {
      setInfo(i);
      setLimitMb(String(Math.round(i.maxBytes / MB)));
    });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const mb = Number(limitMb);
  const limitOk = Number.isInteger(mb) && mb > 0 && mb <= 1024 * 1024;
  const title = t('mediaExport.title', { defaultValue: 'Export PDF files and screenshots' });
  const authLabel =
    info?.auth === 'none' || !info
      ? t('mediaExport.authNone', { defaultValue: 'none' })
      : info.auth;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[480px] rounded-md border border-surface-700 bg-surface-900 p-5 text-surface-100 shadow-xl">
        <h2 className="mb-3 text-[15px] font-semibold">{title}</h2>
        <label className="flex items-center gap-2 py-0.5 text-[12px]">
          <input type="checkbox" checked={pdfs} onChange={(e) => setPdfs(e.target.checked)} />
          {t('mediaExport.pdfs', { defaultValue: 'PDF files of the crawl (downloaded now, into pdfs/, with pdfs.csv)' })}
        </label>
        <label className="flex items-center gap-2 py-0.5 text-[12px]">
          <input type="checkbox" checked={screenshots} onChange={(e) => setScreenshots(e.target.checked)} />
          {t('mediaExport.screenshots', { defaultValue: 'Screenshots taken during the crawl (with screenshots.csv)' })}
        </label>

        <div className="mt-3 rounded border border-surface-800 bg-surface-950/40 px-3 py-2 text-[11px] text-surface-300">
          <div className="mb-1 font-medium text-surface-200">
            {t('mediaExport.requestTitle', { defaultValue: 'PDF requests use the crawl settings' })}
          </div>
          {info ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <dt>{t('mediaExport.userAgent', { defaultValue: 'User agent' })}</dt>
              <dd className="truncate font-mono" title={info.userAgent}>
                {info.userAgent}
              </dd>
              <dt>{t('mediaExport.headers', { defaultValue: 'Custom headers' })}</dt>
              <dd className="truncate font-mono">
                {info.headerNames.length > 0
                  ? info.headerNames.join(', ')
                  : t('mediaExport.headersNone', { defaultValue: 'none' })}
              </dd>
              <dt>{t('mediaExport.auth', { defaultValue: 'Authentication' })}</dt>
              <dd>{authLabel}</dd>
            </dl>
          ) : (
            <div>{t('common.loading', { defaultValue: 'Loading…' })}</div>
          )}
          {info?.formLogin && (
            <div className="mt-1 text-amber-300">
              {t('mediaExport.formLogin', {
                defaultValue:
                  'The crawl logs in through a form: the PDF files cannot be requested that way and are skipped.',
              })}
            </div>
          )}
          <button
            type="button"
            className="mt-1 text-blue-300 underline-offset-2 hover:underline"
            onClick={onOpenSettings}
          >
            {t('mediaExport.openSettings', { defaultValue: 'Change in Settings' })}
          </button>
        </div>

        <label className="mt-3 flex items-center gap-2 text-[12px]">
          <span>{t('mediaExport.limit', { defaultValue: 'Stop downloading PDF files after (MB, all files together)' })}</span>
          <input
            type="number"
            min={1}
            step={1}
            value={limitMb}
            disabled={!pdfs}
            onChange={(e) => setLimitMb(e.target.value)}
            className="w-24 rounded border border-surface-700 bg-surface-950 px-2 py-1 text-[12px] outline-none focus:border-blue-500"
          />
        </label>
        <p className="mt-1 text-[11px] text-surface-500">
          {t('mediaExport.limitHint', {
            defaultValue: 'Kept in the project: saved export sets and scheduled crawls use the same limit.',
          })}
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-surface-700 bg-surface-800 px-3 py-1.5 text-[12px] hover:bg-surface-700"
            onClick={onClose}
          >
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="button"
            className="rounded bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            disabled={busy || !info || (!pdfs && !screenshots) || (pdfs && !limitOk)}
            onClick={() => {
              setBusy(true);
              const what: ('pdfs' | 'screenshots')[] = [];
              if (pdfs) what.push('pdfs');
              if (screenshots) what.push('screenshots');
              const maxBytes = pdfs && limitOk ? mb * MB : (info?.maxBytes ?? 0);
              void window.freecrawl
                .exportMediaRun({ what, maxBytes })
                .then((r) => {
                  if (r.outputDir) onClose();
                })
                .finally(() => setBusy(false));
            }}
          >
            {t('export.exportButton', { defaultValue: 'Export' })}
          </button>
        </div>
      </div>
    </div>
  );
}
