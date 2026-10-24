type T = (key: string, opts?: Record<string, unknown>) => string;

/**
 * Header of the Reports dialog: "N rows · M URLs". Top Words sums mentions,
 * not URLs, so it says "M mentions" instead (B84b).
 */
export function reportSummary(kind: string, rows: number, total: number, t: T): string {
  if (kind === 'top-words') {
    return t('reports.summaryMentions', {
      defaultValue: '{{rows}} rows · {{count}} mentions',
      rows: rows.toLocaleString(),
      count: total,
    });
  }
  return t('reports.summary', {
    defaultValue: '{{rows}} rows · {{urls}} URLs',
    rows: rows.toLocaleString(),
    urls: total.toLocaleString(),
  });
}
