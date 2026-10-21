import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { MonitorHistoryRow } from '@freecrawl/shared-types';

const DEFAULT_METRICS = ['indexable', 'status.4xx'];
const W = 560;
const H = 120;
const PAD = { l: 44, r: 12, t: 10, b: 18 };

/**
 * B88e — Trends: one hand-drawn SVG line per chosen metric over the
 * crawls of the current site (the project's history, same data as
 * `freecrawl history`). Each metric has its own scale, so a count in the
 * thousands does not flatten one in single digits. Same shell and classes
 * as Saved Export Sets.
 */
interface TrendsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function TrendsDialog({ open, onClose }: TrendsDialogProps) {
  const { t } = useTranslation();
  const [names, setNames] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>(DEFAULT_METRICS);
  const [filter, setFilter] = useState('');
  const [rows, setRows] = useState<MonitorHistoryRow[]>([]);
  const [error, setError] = useState('');
  const [hover, setHover] = useState<{ metric: string; i: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    void window.freecrawl
      .monitorMetrics()
      .then((all) => setNames(all.filter((n) => !n.includes('<'))));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setError('');
    setHover(null);
    window.freecrawl
      .monitorHistory(picked)
      .then(setRows)
      .catch((err: unknown) => {
        setRows([]);
        setError(
          `${t('trends.loadFailed', { defaultValue: 'Could not load the crawl history' })}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }, [open, picked, t]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => names.filter((n) => !q || n.toLowerCase().includes(q)), [names, q]);
  const toggle = (name: string) =>
    setPicked((p) => (p.includes(name) ? p.filter((n) => n !== name) : [...p, name]));
  const fmtDate = (iso: string) => new Date(iso).toLocaleString();

  if (!open) return null;

  const chart = (metric: string) => {
    const vals = rows.map((r) => r.values[metric] ?? null);
    const nums = vals.filter((v): v is number => v !== null);
    const min = nums.length ? Math.min(...nums) : 0;
    const max = nums.length ? Math.max(...nums) : 0;
    const span = max - min || 1;
    const x = (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / Math.max(1, vals.length - 1);
    const y = (v: number) => PAD.t + (1 - (v - min) / span) * (H - PAD.t - PAD.b);
    // A not-computed crawl breaks the line instead of reading as zero.
    const d = vals
      .map((v, i) =>
        v === null
          ? ''
          : `${i > 0 && vals[i - 1] !== null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`,
      )
      .join(' ');
    const tip = hover?.metric === metric ? hover.i : null;
    return (
      <div
        key={metric}
        className="relative rounded border border-surface-800 bg-surface-950/50 p-2"
      >
        <div className="mb-1 font-mono text-[11px] text-surface-300">{metric}</div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHover(null)}>
          <line
            x1={PAD.l}
            x2={W - PAD.r}
            y1={H - PAD.b}
            y2={H - PAD.b}
            className="stroke-surface-700"
          />
          <text
            x={PAD.l - 4}
            y={PAD.t + 4}
            textAnchor="end"
            className="fill-surface-500 text-[10px]"
          >
            {max}
          </text>
          <text
            x={PAD.l - 4}
            y={H - PAD.b}
            textAnchor="end"
            className="fill-surface-500 text-[10px]"
          >
            {min}
          </text>
          <path
            data-testid={`trends-line-${metric}`}
            d={d}
            fill="none"
            strokeWidth={1.5}
            className="stroke-blue-400"
          />
          {vals.map((v, i) =>
            v === null ? null : (
              <circle
                key={i}
                data-testid={`trends-point-${metric}-${i}`}
                cx={x(i)}
                cy={y(v)}
                r={tip === i ? 4 : 3}
                className="fill-blue-400"
                onMouseEnter={() => setHover({ metric, i })}
              />
            ),
          )}
        </svg>
        {tip !== null && rows[tip] && (
          <div
            data-testid="trends-tooltip"
            className="pointer-events-none absolute right-2 top-2 rounded border border-surface-700 bg-surface-900 px-2 py-1 text-[11px] text-surface-100 shadow"
          >
            {fmtDate(rows[tip].finishedAt)}:{' '}
            {rows[tip].values[metric] ?? t('trends.notComputed', { defaultValue: 'not computed' })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        data-testid="trends-view"
        className="flex max-h-[90vh] w-[960px] max-w-[95vw] flex-col rounded-md border border-surface-700 bg-surface-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-surface-800 px-4 py-2.5">
          <div className="text-sm font-semibold text-surface-100">
            {t('trends.title', { defaultValue: 'Trends' })}
          </div>
          <button
            className="rounded p-1 text-surface-400 hover:bg-surface-800 hover:text-surface-100"
            onClick={onClose}
            title={t('common.close', { defaultValue: 'Close' })}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[260px_1fr] gap-4 overflow-hidden px-4 py-3">
          <section className="flex min-h-0 flex-col">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-surface-400">
              {t('trends.metrics', { defaultValue: 'Metrics' })}
            </div>
            <input
              type="text"
              data-testid="trends-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('common.search', { defaultValue: 'Search' })}
              className="mb-1.5 rounded border border-surface-700 bg-surface-950 px-2 py-1 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none"
            />
            <div className="max-h-[420px] overflow-auto rounded border border-surface-800 bg-surface-950/50 p-2">
              {shown.map((n) => {
                const checked = picked.includes(n);
                return (
                  <label
                    key={n}
                    className={clsx(
                      'flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12px]',
                      checked
                        ? 'bg-accent-500/10 text-surface-100'
                        : 'text-surface-300 hover:bg-surface-800/60',
                    )}
                  >
                    <input
                      type="checkbox"
                      data-testid={`trends-metric-${n}`}
                      className="h-3.5 w-3.5"
                      checked={checked}
                      onChange={() => toggle(n)}
                    />
                    <span className="truncate font-mono text-[11px]">{n}</span>
                  </label>
                );
              })}
            </div>
          </section>

          <section className="flex min-h-0 flex-col gap-2 overflow-auto">
            {error ? (
              <div className="px-2 py-4 text-center text-[11px] text-red-400">{error}</div>
            ) : rows.length < 2 ? (
              <div
                data-testid="trends-empty"
                className="px-2 py-8 text-center text-[12px] text-surface-500"
              >
                {t('trends.needTwo', {
                  defaultValue:
                    'Needs two crawls of this site. Crawl it again to see how the counts move.',
                })}
              </div>
            ) : (
              picked.map(chart)
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
