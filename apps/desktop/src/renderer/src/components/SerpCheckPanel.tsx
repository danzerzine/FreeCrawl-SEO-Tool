import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_SEO_THRESHOLDS,
  resolveSeoThresholds,
  type SerpRowResult,
  type SerpStatus,
} from '@freecrawl/shared-types';
import { useAppStore } from '../store.js';

const ROW_HEIGHT = 74;
const CHECK_DELAY_MS = 250;

const STATUS_CLASS: Record<SerpStatus, string> = {
  ok: 'border-emerald-800 bg-emerald-900/40 text-emerald-300',
  missing: 'border-rose-800 bg-rose-900/40 text-rose-300',
  'too-short': 'border-amber-800 bg-amber-900/40 text-amber-300',
  'too-long': 'border-amber-800 bg-amber-900/40 text-amber-300',
  'pixel-too-short': 'border-amber-800 bg-amber-900/40 text-amber-300',
  'pixel-too-long': 'border-amber-800 bg-amber-900/40 text-amber-300',
};

/**
 * SERP check (B85): paste titles and descriptions (or open a file), see each against Google's
 * snippet limits with a preview clipped where Google clips it. Limits are the open project's, else
 * the defaults. Nothing is fetched and nothing is stored in the project.
 */
export function SerpCheckPanel() {
  const { t } = useTranslation();
  const projectThresholds = useAppStore((s) => s.overview?.thresholds);
  const [text, setText] = useState('');
  const [results, setResults] = useState<SerpRowResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const limits = resolveSeoThresholds(projectThresholds ?? DEFAULT_SEO_THRESHOLDS);

  useEffect(() => {
    if (text.trim() === '') {
      setResults([]);
      setError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.freecrawl
        .reportsSerpCheck({ text, thresholds: limits })
        .then((r) => {
          if (cancelled) return;
          setResults(r);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setResults([]);
          setError(e instanceof Error ? e.message : String(e));
        });
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `limits` is rebuilt every render; its content only changes with the project's thresholds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, JSON.stringify(limits)]);

  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const statusLabel = (s: SerpStatus): string => {
    switch (s) {
      case 'ok':
        return t('reports.serp.statusOk', { defaultValue: 'OK' });
      case 'missing':
        return t('reports.serp.statusMissing', { defaultValue: 'Missing' });
      case 'too-short':
        return t('reports.serp.statusTooShort', { defaultValue: 'Too short' });
      case 'too-long':
        return t('reports.serp.statusTooLong', { defaultValue: 'Too long' });
      case 'pixel-too-long':
        return t('reports.serp.statusTooWide', { defaultValue: 'Too wide' });
      case 'pixel-too-short':
        return t('reports.serp.statusTooNarrow', { defaultValue: 'Too narrow' });
    }
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    void file.text().then(setText);
  };

  const bad = results.filter((r) => r.titleStatus !== 'ok' || r.descStatus !== 'ok').length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3 text-[11px]">
      <textarea
        className="h-28 w-full resize-y rounded border border-surface-700 bg-surface-950 p-2 font-mono text-[11px] text-surface-100 placeholder:text-surface-500 focus:border-blue-500 focus:outline-none"
        placeholder={t('reports.serp.paste', {
          defaultValue:
            'Paste titles and descriptions (one page per line, title and description separated by a tab)',
        })}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div className="flex items-center gap-3 text-surface-400">
        <button
          className="rounded border border-surface-700 bg-surface-800 px-2 py-0.5 text-surface-100 hover:bg-surface-700"
          onClick={() => fileRef.current?.click()}
        >
          {t('reports.serp.openFile', { defaultValue: 'Open file…' })}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,.txt,text/*"
          className="hidden"
          onChange={(e) => {
            onFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <span className="text-surface-500">
          {t('reports.serp.limitsFrom', {
            defaultValue:
              'Limits: title {{tMin}}-{{tMax}} chars, {{tMaxPx}} px; description {{dMin}}-{{dMax}} chars, {{dMaxPx}} px',
            tMin: limits.titleMinChars,
            tMax: limits.titleMaxChars,
            tMaxPx: limits.titleMaxPx,
            dMin: limits.descriptionMinChars,
            dMax: limits.descriptionMaxChars,
            dMaxPx: limits.descriptionMaxPx,
          })}
        </span>
        <span className="ml-auto">
          {t('reports.serp.summary', {
            defaultValue: '{{rows}} rows · {{bad}} with a problem',
            rows: results.length.toLocaleString(),
            bad: bad.toLocaleString(),
          })}
        </span>
      </div>
      {error && (
        <div className="rounded border border-rose-800 bg-rose-900/30 px-2 py-1 text-rose-300">
          {error}
        </div>
      )}
      <div ref={scrollRef} className="min-h-[120px] flex-1 overflow-auto">
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const r = results[vi.index];
            if (!r) return null;
            return (
              <div
                key={vi.index}
                className="absolute left-0 top-0 flex w-full gap-3 border-b border-surface-900 py-1.5"
                style={{ height: ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
              >
                <div className="w-6 shrink-0 text-right text-surface-500">{vi.index + 1}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-blue-400" title={r.title}>
                    {r.titleTruncated}
                    {r.titleTruncated !== r.title && '…'}
                  </div>
                  <div
                    className="truncate text-[11px] text-surface-300"
                    style={{ maxWidth: limits.descriptionMaxPx }}
                    title={r.description}
                  >
                    {r.description}
                  </div>
                </div>
                <div className="flex w-40 shrink-0 flex-col items-start gap-1">
                  <Chip
                    status={r.titleStatus}
                    label={statusLabel(r.titleStatus)}
                    detail={`${r.titleChars} / ${r.titlePx}px`}
                  />
                  <Chip
                    status={r.descStatus}
                    label={statusLabel(r.descStatus)}
                    detail={`${r.descChars} / ${r.descPx}px`}
                  />
                  {(r.duplicateTitle > 0 || r.duplicateDescription > 0) && (
                    <span className="text-surface-400">
                      {t('reports.serp.duplicate', { defaultValue: 'Duplicate' })}
                      {r.duplicateTitle > 0 && ` T×${r.duplicateTitle}`}
                      {r.duplicateDescription > 0 && ` D×${r.duplicateDescription}`}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Chip({ status, label, detail }: { status: SerpStatus; label: string; detail: string }) {
  return (
    <span className={clsx('rounded border px-1.5 py-px', STATUS_CLASS[status])}>
      {label} <span className="opacity-70">{detail}</span>
    </span>
  );
}
