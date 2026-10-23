import { useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LinkSuggestionResult, LinkSuggestionRow } from '@freecrawl/shared-types';
import { InfoTip } from './InfoTip.js';

const INFO_TIP =
  'Effective inlinks are the other pages that really link to a page: links from menus and footers, redirects to it counted once, and links to itself are left out. A page with few of them is hard for visitors and search engines to find. Closeness (0-100) says how much a candidate page and the weak page talk about the same things, judged by the rare words in their titles, headings and descriptions. A source is only listed if it does not link to the page yet.';

const DEFAULTS = { maxInlinks: 3, perTarget: 5, perSource: 10, minCloseness: 20 };

interface TargetGroup {
  url: string;
  title: string | null;
  inlinks: number;
  rows: LinkSuggestionRow[];
}

/** Rows come ordered by target; rank 0 rows are targets with no suggestion. */
function groupByTarget(rows: LinkSuggestionRow[]): TargetGroup[] {
  const out: TargetGroup[] = [];
  let cur: TargetGroup | null = null;
  for (const r of rows) {
    if (!cur || cur.url !== r.targetUrl) {
      cur = { url: r.targetUrl, title: r.targetTitle, inlinks: r.targetInlinks, rows: [] };
      out.push(cur);
    }
    if (r.rank > 0) cur.rows.push(r);
  }
  return out;
}

/**
 * Link suggestions (B93): pages with few inlinks and the pages that talk about the same things but
 * do not link to them yet. Computed on request (it can take minutes on a big site) on a worker.
 */
export function LinkSuggestionsPanel() {
  const { t } = useTranslation();
  const [maxInlinks, setMaxInlinks] = useState(DEFAULTS.maxInlinks);
  const [perTarget, setPerTarget] = useState(DEFAULTS.perTarget);
  const [perSource, setPerSource] = useState(DEFAULTS.perSource);
  const [minCloseness, setMinCloseness] = useState(DEFAULTS.minCloseness);
  const [result, setResult] = useState<LinkSuggestionResult | null>(null);
  const [notComputed, setNotComputed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [saved, setSaved] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const groups = result ? groupByTarget(result.rows) : [];
  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30,
    overscan: 10,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  const compute = async () => {
    setLoading(true);
    setError(null);
    setSaved(null);
    try {
      const r = await window.freecrawl.reportsLinkSuggestions({
        maxInlinks,
        perTarget,
        perSource,
        minCloseness,
      });
      setNotComputed(r === null);
      setResult(r);
      setOpen(new Set());
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = async () => {
    if (!result) return;
    const r = await window.freecrawl.reportsLinkSuggestionsExport(result.rows);
    setSaved(r.filePath || null);
  };

  const toggle = (url: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });

  const field = (
    label: string,
    value: number,
    set: (n: number) => void,
    min: number,
    max: number,
  ) => (
    <label className="flex items-center gap-1.5">
      <span className="text-surface-400">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        className="w-14 rounded border border-surface-700 bg-surface-950 px-1.5 py-0.5 text-[11px] text-surface-100 focus:border-blue-500 focus:outline-none"
        value={value}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          if (Number.isFinite(n)) set(Math.min(max, Math.max(min, n)));
        }}
      />
    </label>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3 text-[11px]">
      <div className="flex flex-wrap items-center gap-3">
        {field(
          t('reports.linkSuggestions.maxInlinks', { defaultValue: 'Pages with at most … inlinks' }),
          maxInlinks,
          setMaxInlinks,
          0,
          50,
        )}
        {field(
          t('reports.linkSuggestions.perTarget', { defaultValue: 'Suggestions per page' }),
          perTarget,
          setPerTarget,
          1,
          20,
        )}
        {field(
          t('reports.linkSuggestions.perSource', { defaultValue: 'Max uses of one source page' }),
          perSource,
          setPerSource,
          1,
          100,
        )}
        {field(
          t('reports.linkSuggestions.minCloseness', { defaultValue: 'Min. closeness' }),
          minCloseness,
          setMinCloseness,
          0,
          100,
        )}
        <InfoTip info={INFO_TIP} />
      </div>
      <div className="flex items-center gap-3">
        <button
          className="rounded border border-surface-700 bg-surface-800 px-2 py-0.5 text-surface-100 hover:bg-surface-700 disabled:opacity-50"
          disabled={loading}
          onClick={() => void compute()}
        >
          {loading
            ? t('reports.linkSuggestions.computing', { defaultValue: 'Computing…' })
            : t('reports.linkSuggestions.compute', { defaultValue: 'Find suggestions' })}
        </button>
        <button
          className="rounded border border-surface-700 bg-surface-800 px-2 py-0.5 text-surface-100 hover:bg-surface-700 disabled:opacity-50"
          disabled={!result || result.rows.length === 0}
          onClick={() => void exportCsv()}
        >
          {t('reports.linkSuggestions.exportCsv', { defaultValue: 'Export CSV' })}
        </button>
        {result && (
          <span className="text-surface-500">
            {t('reports.linkSuggestions.summary', {
              defaultValue: '{{targets}} pages with few links, {{without}} without a suggestion',
              targets: result.targets.toLocaleString(),
              without: result.withoutSuggestion.toLocaleString(),
            })}
          </span>
        )}
        {saved && <span className="truncate text-surface-500">{saved}</span>}
      </div>
      {error && <div className="text-rose-300">{error}</div>}
      {notComputed && (
        <div className="p-6 text-center text-surface-500">
          {t('reports.linkSuggestions.notComputed', {
            defaultValue: 'Not computed. Run a crawl that counts inlinks first.',
          })}
        </div>
      )}
      {result?.truncated && (
        <div className="text-amber-300">
          {t('reports.linkSuggestions.truncated', {
            defaultValue:
              'Partial result: more weak pages exist than were looked at, or the time limit was reached.',
          })}
        </div>
      )}
      {result?.degraded && (
        <div className="text-amber-300">
          {t('reports.linkSuggestions.degraded', {
            defaultValue: 'Very large site: only the most distinctive words were compared.',
          })}
        </div>
      )}
      {result?.redirectsFolded === 'one-hop' && (
        <div className="text-amber-300">
          {t('reports.linkSuggestions.oneHop', {
            defaultValue:
              'Redirect ends were not computed, so links were followed through one redirect only.',
          })}
        </div>
      )}
      {result && groups.length === 0 && !notComputed && (
        <div className="p-6 text-center text-surface-500">
          {t('reports.linkSuggestions.empty', { defaultValue: 'No pages with so few links.' })}
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {groups.length > 0 && (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const g = groups[vi.index]!;
              const isOpen = open.has(g.url);
              return (
                <div
                  key={g.url}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full border-b border-surface-900"
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  <button
                    className="flex w-full items-center gap-2 py-1 text-left hover:bg-surface-900/50"
                    onClick={() => toggle(g.url)}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-surface-400" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-surface-400" />
                    )}
                    <span className="min-w-0 flex-1 break-all text-surface-100">{g.url}</span>
                    <span className="w-20 shrink-0 text-right text-surface-400">
                      {t('reports.linkSuggestions.inlinks', {
                        defaultValue: '{{count}} inlinks',
                        count: g.inlinks,
                      })}
                    </span>
                    <span className="w-24 shrink-0 text-right text-surface-400">
                      {g.rows.length === 0
                        ? t('reports.linkSuggestions.noSuggestion', {
                            defaultValue: 'No suggestion',
                          })
                        : t('reports.linkSuggestions.sources', {
                            defaultValue: '{{count}} sources',
                            count: g.rows.length,
                          })}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="pb-2 pl-6">
                      {g.title && <div className="pb-1 text-surface-400">{g.title}</div>}
                      {g.rows.map((r) => (
                        <div key={r.sourceUrl} className="flex gap-2 py-0.5">
                          <span className="w-10 shrink-0 text-right text-surface-300">
                            {r.closeness ?? ''}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="break-all text-surface-100">{r.sourceUrl}</div>
                            {r.suggestedAnchor && (
                              <div className="text-surface-500">
                                {t('reports.linkSuggestions.anchor', {
                                  defaultValue: 'Anchor: {{text}}',
                                  text: r.suggestedAnchor,
                                })}
                                {r.sameSection
                                  ? ` · ${t('reports.linkSuggestions.sameSection', { defaultValue: 'same section' })}`
                                  : ''}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
