/** B41: pure helpers of the Lighthouse sub-tab (kept out of the component so they can be tested). */
import type {
  PagespeedAuditItem,
  PagespeedAuditKind,
  PagespeedAuditRow,
  PagespeedStrategy,
} from './pagespeed.js';

const KIND_ORDER: Record<PagespeedAuditKind, number> = {
  opportunity: 0,
  insight: 1,
  diagnostic: 2,
};

/** The chosen device's audits: opportunities, then insights, then diagnostics; biggest saving first in each. */
export function orderForView(
  rows: PagespeedAuditRow[],
  strategy: PagespeedStrategy,
): PagespeedAuditRow[] {
  return rows
    .filter((r) => r.strategy === strategy)
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        (b.savingsMs ?? -1) - (a.savingsMs ?? -1) ||
        (b.savingsBytes ?? -1) - (a.savingsBytes ?? -1),
    );
}

/** An unknown saving is a dash, never 0. */
export function formatSavingsMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export function formatKb(bytes: number | null): string {
  if (bytes === null) return '—';
  const kb = bytes / 1024;
  return `${kb >= 10 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`;
}

/** One readable line for a stored resource. */
export function resourceLine(item: PagespeedAuditItem): string {
  const parts: string[] = [];
  const subject = item.url ?? item.source ?? item.label;
  if (subject !== undefined) parts.push(subject);
  if (item.selector !== undefined) parts.push(item.selector);
  if (item.snippet !== undefined) parts.push(item.snippet);
  if (item.value !== undefined) parts.push(item.value ? 'yes' : 'no');
  if (item.wastedBytes !== undefined) parts.push(formatKb(item.wastedBytes));
  else if (item.totalBytes !== undefined) parts.push(formatKb(item.totalBytes));
  if (item.wastedMs !== undefined) parts.push(`${Math.round(item.wastedMs)} ms`);
  return parts.join(' · ');
}
