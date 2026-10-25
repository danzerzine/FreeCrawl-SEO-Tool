import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store.js';

/**
 * The stored rows of one page for a detail sub-tab (axe, Lighthouse), loaded again when the page or the
 * project data changes. `rows` is null while loading; a failed load leaves `loadError` set and no rows.
 * `open` is the one expanded row, closed whenever the page changes.
 */
export function useStoredRows<T>(
  pageUrl: string,
  load: (pageUrl: string) => Promise<{ rows: T[] }>,
): {
  rows: T[] | null;
  loadError: string | null;
  open: string | null;
  setOpen: (key: string | null) => void;
} {
  const dataVersion = useAppStore((s) => s.dataVersion);
  const loader = useRef(load);
  loader.current = load;
  const [rows, setRows] = useState<T[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setLoadError(null);
    setOpen(null);
    void loader
      .current(pageUrl)
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

  return { rows, loadError, open, setOpen };
}

/** The message a detail sub-tab shows when its rows could not be read. */
export function LoadFailed({ error }: { error: string }) {
  const { t } = useTranslation();
  return (
    <div className="p-3 text-[11px]">
      <div className="font-semibold text-rose-300">
        {t('common.loadFailedTitle', { defaultValue: "Couldn't load this view" })}
      </div>
      <div className="mt-0.5 break-words text-surface-500">{error}</div>
    </div>
  );
}
