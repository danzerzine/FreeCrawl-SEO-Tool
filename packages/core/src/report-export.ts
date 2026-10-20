/**
 * Report files that are not a URL list: the link reports grouped by
 * target (Reports → Internal Links) and the one-file issue summary.
 * Both go through `.part` + rename like every other export file.
 */

import { writeFile } from 'node:fs/promises';
import type { ProjectDb } from '@freecrawl/db';
import {
  ISSUE_GROUPS,
  ISSUE_SEVERITY,
  issueCount,
  type LinkTargetReportKind,
} from '@freecrawl/shared-types';
import { escapeCsv } from './spreadsheet.js';
import { writeExportFile } from './export-file.js';

/** The four by-target link reports: file stem and label, in Reports order. */
export const LINK_TARGET_EXPORTS: readonly { report: LinkTargetReportKind; label: string }[] = [
  { report: 'redirects-to-error', label: 'Internal Links — Redirects to Error' },
  { report: 'error-inlinks', label: 'Internal Links — To Error Pages' },
  { report: 'non-indexable-inlinks', label: 'Internal Links — To Non-Indexable Pages' },
  { report: 'redirect-inlinks', label: 'Internal Links — To Redirects' },
];

/** By-target report columns: header label and the `LinkTargetRow` key `headers: 'keys'` writes. */
const LINK_TARGET_COLUMNS: readonly { key: string; label: string }[] = [
  { key: 'targetUrl', label: 'Target URL' },
  { key: 'statusCode', label: 'Status Code' },
  { key: 'indexability', label: 'Indexability' },
  { key: 'finalUrl', label: 'Final URL' },
  { key: 'finalStatusCode', label: 'Final Status Code' },
  { key: 'finalIndexability', label: 'Final Indexability' },
  { key: 'sourcePages', label: 'Source Pages' },
  { key: 'isTemplate', label: 'Template Link' },
  { key: 'topPosition', label: 'Top Position' },
  { key: 'sampleSourceUrl', label: 'Sample Source URL' },
];

/** Header row of a report file: the labels, or the keys for scripts. */
type ReportHeaders = 'labels' | 'keys';

/** CSV with a BOM; `'keys'` mode is machine mode, without the formula guard. */
function csv(rows: readonly (readonly unknown[])[], headers?: ReportHeaders): string {
  const cell = { formulaGuard: headers !== 'keys' };
  return '\ufeff' + rows.map((r) => r.map((c) => escapeCsv(c, cell)).join(',')).join('\n') + '\n';
}

/**
 * Every target of one link report, one row per target. Returns null and
 * writes nothing when the report needs the redirect-chain pass and the
 * crawl has not run it (see `ProjectDb.linkTargetReport`); an empty
 * report leaves no file, like an empty bulk category.
 */
export async function exportLinkTargetReport(
  db: ProjectDb,
  filePath: string,
  report: LinkTargetReportKind,
  options: { headers?: ReportHeaders } = {},
): Promise<{ rowsWritten: number } | null> {
  // One row per target, not per link, so the whole list fits in memory.
  const rows = db.linkTargetReport({ report, limit: Number.MAX_SAFE_INTEGER });
  if (rows === null) return null;
  return writeExportFile(
    filePath,
    async (partPath) => {
      await writeFile(
        partPath,
        csv([
          LINK_TARGET_COLUMNS.map((c) => (options.headers === 'keys' ? c.key : c.label)),
          ...rows.map((r) => [
            r.targetUrl,
            r.statusCode,
            r.indexability,
            r.finalUrl,
            r.finalStatusCode,
            r.finalIndexability,
            r.sourcePages,
            r.isTemplate ? 'yes' : 'no',
            r.topPosition,
            r.sampleSourceUrl,
          ]),
        ], options.headers),
        'utf8',
      );
      return { rowsWritten: rows.length };
    },
    (r) => r.rowsWritten > 0,
  );
}

/**
 * One row per issue check of the Overview sidebar: its key, label, group,
 * severity and the URL count the sidebar shows (empty when the crawl has
 * not computed that check). Checks turned off in Settings → Issues are
 * left out, as everywhere else.
 */
export async function exportIssuesSummary(
  db: ProjectDb,
  filePath: string,
  options: { headers?: ReportHeaders } = {},
): Promise<{ rowsWritten: number }> {
  const disabled = db.getDisabledIssues();
  const issues = db.getOverviewCounts().issues;
  const rows = ISSUE_GROUPS.flatMap((g) =>
    g.items
      .filter((i) => !disabled.has(i.category))
      .map((i) => [i.category, i.label, g.label, ISSUE_SEVERITY[i.category] ?? '', issueCount(issues, i)]),
  );
  return writeExportFile(filePath, async (partPath) => {
    const head =
      options.headers === 'keys'
        ? ['check', 'label', 'group', 'severity', 'urls']
        : ['Check', 'Label', 'Group', 'Severity', 'URLs'];
    await writeFile(partPath, csv([head, ...rows], options.headers), 'utf8');
    return { rowsWritten: rows.length };
  });
}
