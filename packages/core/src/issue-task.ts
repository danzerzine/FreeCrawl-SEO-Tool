import {
  fillThresholdLabel,
  ISSUE_GROUPS,
  ISSUE_SEVERITY,
  type IssueCheckDef,
  type OverviewCounts,
  type UrlCategory,
} from '@freecrawl/shared-types';
import { issueAdvice, issueReportSeverity, severityFallback } from './html-report.js';

/** One flagged URL with the values that make the check fire (column name to value). */
export interface IssueTaskRow {
  url: string;
  evidence: Record<string, string | number | null>;
}

export interface BuildIssueTaskInput {
  category: UrlCategory;
  counts: Pick<OverviewCounts, 'issues' | 'thresholds'>;
  /** First N flagged URLs, already fetched by the caller. */
  rows: IssueTaskRow[];
  /** Flagged URLs in total; defaults to the check's counter. */
  totalUrls?: number;
  siteUrl: string;
  /** ISO timestamp of the crawl. */
  crawledAt: string;
  maxUrls?: number;
  maxBodyChars?: number;
}

export interface IssueTaskSection {
  heading: string;
  text: string;
  table?: { header: string[]; rows: string[][] };
  /** Line after the table. */
  note?: string;
}

/** The one structure both renderers work from. Text fields are raw, unescaped. */
export interface IssueTask {
  title: string;
  /** Optional paragraph the user adds in the dialog. */
  note?: string;
  sections: IssueTaskSection[];
  moreUrls: number;
  truncated: boolean;
}

const DEFAULT_COLUMNS = ['statusCode', 'indexability'];
const EVIDENCE_BY_PREFIX: [string, string[]][] = [
  ['issues:title-', ['title', 'titleLength']],
  ['issues:meta-', ['metaDescriptionLength']],
  ['issues:h1-', ['h1', 'h1Count']],
  ['issues:canonical-', ['canonicalResolved']],
  ['issues:response-', ['responseTimeMs']],
  ['issues:ttfb-', ['ttfbMs']],
];

/** Evidence columns of a check: the `CrawlUrlRow` fields that make it fire. */
export function evidenceColumnsFor(category: string): string[] {
  for (const [prefix, cols] of EVIDENCE_BY_PREFIX) if (category.startsWith(prefix)) return cols;
  return DEFAULT_COLUMNS;
}

function findCheck(category: string): { group: string; def: IssueCheckDef } | undefined {
  for (const g of ISSUE_GROUPS) {
    const def = g.items.find((i) => i.category === category);
    if (def) return { group: g.label, def };
  }
  return undefined;
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function buildIssueTask(input: BuildIssueTaskInput): IssueTask {
  const found = findCheck(input.category);
  if (!found) throw new Error(`Unknown issue check: ${input.category}`);
  const { group, def } = found;
  const th = input.counts.thresholds;
  const label = fillThresholdLabel(def.label, th);
  const keys = Array.isArray(def.count) ? (def.count as string[]) : [def.count as string];
  const counted = keys.reduce((n, k) => n + ((input.counts.issues as Record<string, number>)[k] ?? 0), 0);
  const total = input.totalUrls ?? counted;
  const site = host(input.siteUrl);
  const date = input.crawledAt.slice(0, 10);

  const sections: IssueTaskSection[] = [
    {
      heading: 'What this check means',
      text: `FreeCrawl check "${group}: ${label}" flags the URLs listed below.`,
    },
  ];
  const single = keys.length === 1 ? keys[0] : undefined;
  let sev = single ? issueReportSeverity(single) : undefined;
  if (!sev) {
    const s = ISSUE_SEVERITY[input.category];
    sev = s === 'critical' ? 'error' : s === 'warning' ? 'warn' : s === 'info' ? 'info' : undefined;
  }
  if (sev) sections.push({ heading: 'Why it matters', text: severityFallback(sev) });
  const advice = single ? issueAdvice(single) : undefined;
  if (advice) sections.push({ heading: 'How to fix', text: fillThresholdLabel(advice, th) });

  const cols = evidenceColumnsFor(input.category);
  const cell = (v: string | number | null | undefined) => (v == null ? '' : String(v));
  sections.push({
    heading: 'Affected',
    text: `${total} URL${total === 1 ? '' : 's'}, first ${input.rows.length} shown`,
    table: {
      header: ['URL', ...cols],
      rows: input.rows.map((r) => [r.url, ...cols.map((c) => cell(r.evidence[c]))]),
    },
  });
  sections.push({ heading: 'Found by', text: `FreeCrawl crawl of ${site} on ${date}` });

  return {
    title: `[${site}] ${group}: ${label} (${total} URL${total === 1 ? '' : 's'})`,
    sections,
    moreUrls: 0,
    truncated: false,
  };
}

function mdText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mdCell(v: string): string {
  return v === '' ? '' : `\`${v}\``;
}

export function toMarkdown(task: IssueTask): string {
  const out: string[] = [];
  if (task.note) out.push(mdText(task.note), '');
  for (const s of task.sections) {
    out.push(`## ${mdText(s.heading)}`, '', mdText(s.text), '');
    if (s.table) {
      const { header, rows } = s.table;
      out.push(`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`);
      for (const r of rows) out.push(`| ${r.map(mdCell).join(' | ')} |`);
      out.push('');
    }
    if (s.note) out.push(mdText(s.note), '');
  }
  return out.join('\n').trimEnd() + '\n';
}

export function toBasecampHtml(_task: IssueTask): string {
  return '';
}
