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

const LINK_TARGET_HEADER = [
  'Target URL',
  'Status Code',
  'Indexability',
  'Final URL',
  'Final Status Code',
  'Final Indexability',
  'Source Pages',
  'Template Link',
  'Top Position',
  'Sample Source URL',
];

function csv(rows: readonly (readonly unknown[])[]): string {
  return '﻿' + rows.map((r) => r.map(escapeCsv).join(',')).join('\n') + '\n';
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
          LINK_TARGET_HEADER,
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
        ]),
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
): Promise<{ rowsWritten: number }> {
  const disabled = db.getDisabledIssues();
  const issues = db.getOverviewCounts().issues;
  const rows = ISSUE_GROUPS.flatMap((g) =>
    g.items
      .filter((i) => !disabled.has(i.category))
      .map((i) => [i.category, i.label, g.label, ISSUE_SEVERITY[i.category] ?? '', issueCount(issues, i)]),
  );
  return writeExportFile(filePath, async (partPath) => {
    await writeFile(partPath, csv([['Check', 'Label', 'Group', 'Severity', 'URLs'], ...rows]), 'utf8');
    return { rowsWritten: rows.length };
  });
}
