import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { SitemapGenerateInput } from '@freecrawl/shared-types';

export type SitemapLastmod = NonNullable<SitemapGenerateInput['lastmod']>;
export type SitemapVariantChoice = NonNullable<SitemapGenerateInput['variant']>;

const LASTMODS: SitemapLastmod[] = ['chain', 'last-modified', 'sitemap', 'crawl', 'none'];

const DEFAULT_LABELS: Record<SitemapLastmod, string> = {
  chain: "Page's Last-Modified if trustworthy, else the site's sitemap, else none (recommended)",
  'last-modified': "Page's Last-Modified header only",
  sitemap: "The site's own sitemap only",
  crawl: 'Crawl date',
  none: 'No lastmod',
};

/** Per-viewer convenience: the source picked last time. */
const STORAGE_KEY = 'freecrawl.sitemapLastmod';

function storedLastmod(): SitemapLastmod {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return LASTMODS.includes(v as SitemapLastmod) ? (v as SitemapLastmod) : 'chain';
  } catch {
    return 'chain';
  }
}

interface SitemapOptionsDialogProps {
  /** The variant the File menu asked for; null keeps the dialog closed. */
  variant: SitemapVariantChoice | null;
  onConfirm: (lastmod: SitemapLastmod) => void;
  onCancel: () => void;
}

/** B154: where each `<lastmod>` of a generated sitemap comes from (the CLI's `--lastmod`). */
export function SitemapOptionsDialog({ variant, onConfirm, onCancel }: SitemapOptionsDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const [lastmod, setLastmod] = useState<SitemapLastmod>('chain');

  useEffect(() => {
    if (variant) setLastmod(storedLastmod());
  }, [variant]);

  useEffect(() => {
    if (!variant) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [variant, onCancel]);

  if (!variant) return null;
  const title = t('sitemapGenerate.title', { defaultValue: 'Generate XML sitemap' });

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
      <div className="w-[480px] rounded-md border border-surface-700 bg-surface-900 p-5 text-surface-100 shadow-xl">
        <h2 className="mb-3 text-[15px] font-semibold">{title}</h2>
        <label className="mb-1 block text-[11px] font-medium text-surface-300" htmlFor="sitemap-lastmod">
          {t('sitemapGenerate.lastmodLabel', { defaultValue: 'Where <lastmod> comes from' })}
        </label>
        <select
          id="sitemap-lastmod"
          className="w-full rounded border border-surface-700 bg-surface-950 px-2 py-1.5 text-[12px] outline-none focus:border-blue-500"
          value={lastmod}
          onChange={(e) => setLastmod(e.target.value as SitemapLastmod)}
        >
          {LASTMODS.map((key) => (
            <option key={key} value={key}>
              {t(`sitemapGenerate.lastmod.${key}`, { defaultValue: DEFAULT_LABELS[key] })}
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
            onClick={() => {
              try {
                window.localStorage.setItem(STORAGE_KEY, lastmod);
              } catch {
                /* the choice is only a convenience */
              }
              onConfirm(lastmod);
            }}
          >
            {t('sitemapGenerate.generate', { defaultValue: 'Generate…' })}
          </button>
        </div>
      </div>
    </div>
  );
}
