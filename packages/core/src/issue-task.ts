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

const URL_COLUMNS = new Set(['url', 'canonicalResolved']);
/** Free text from the page; only these are cut, a cut URL would point nowhere. */
const CUT_COLUMNS = new Set(['title', 'h1']);
const CUT_AT = 200;
const DEFAULT_MAX_URLS = 200;
/** GitHub's issue body limit is not in the REST docs; this is a safe value. */
const DEFAULT_MAX_BODY_CHARS = 60_000;

function stripUserinfo(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1');
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

  const head: IssueTaskSection[] = [
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
  if (sev) head.push({ heading: 'Why it matters', text: severityFallback(sev) });
  const advice = single ? issueAdvice(single) : undefined;
  if (advice) head.push({ heading: 'How to fix', text: fillThresholdLabel(advice, th) });

  const cols = evidenceColumnsFor(input.category);
  const cell = (col: string, v: string | number | null | undefined) => {
    let t = v == null ? '' : String(v).replace(/\r\n|\r|\n/g, ' ');
    if (URL_COLUMNS.has(col)) t = stripUserinfo(t);
    else if (CUT_COLUMNS.has(col) && t.length > CUT_AT) t = t.slice(0, CUT_AT - 1) + '…';
    return t;
  };
  const allRows = input.rows.map((r) => [cell('url', r.url), ...cols.map((c) => cell(c, r.evidence[c]))]);
  const exportName = input.category;
  const title = `[${site}] ${group}: ${label} (${total} URL${total === 1 ? '' : 's'})`;

  const assemble = (shown: number): IssueTask => {
    const more = Math.max(0, total - shown);
    const affected: IssueTaskSection = {
      heading: 'Affected',
      text: `${total} URL${total === 1 ? '' : 's'}, first ${shown} shown`,
      table: { header: ['URL', ...cols], rows: allRows.slice(0, shown) },
    };
    if (more > 0) {
      affected.note = `and ${more} more URL${more === 1 ? '' : 's'} not listed (full list: FreeCrawl export \`${exportName}\` from the crawl of ${site}, ${date})`;
    }
    return {
      title,
      sections: [...head, affected, { heading: 'Found by', text: `FreeCrawl crawl of ${site} on ${date}` }],
      moreUrls: more,
      truncated: more > 0,
    };
  };

  // Largest row count within maxUrls whose rendered body fits maxBodyChars.
  const maxUrls = input.maxUrls ?? DEFAULT_MAX_URLS;
  const maxChars = input.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const fits = (n: number) => {
    const t = assemble(n);
    return toMarkdown(t).length <= maxChars && toBasecampHtml(t).length <= maxChars;
  };
  let lo = 0;
  let hi = Math.min(maxUrls, allRows.length);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return assemble(lo);
}

function mdText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline code span: fence longer than any backtick run inside, padded at edge backticks. */
function mdCell(raw: string): string {
  if (raw === '') return '';
  const v = raw.replace(/\\(?=\|)/g, '\\\\').replace(/\|/g, '\\|');
  const longest = Math.max(0, ...(v.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = v.startsWith('`') || v.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${v}${pad}${fence}`;
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

function htmlText(s: string): string {
  return mdText(s).replace(/"/g, '&quot;');
}

/** Static text with `code` pairs (the export name) turned into <code>. */
function htmlWithCode(s: string): string {
  return htmlText(s).replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Basecamp rich text: the same structure, every text HTML-escaped, the table as a real table. */
export function toBasecampHtml(task: IssueTask): string {
  const out: string[] = [];
  if (task.note) out.push(`<div>${htmlText(task.note)}</div>`);
  for (const s of task.sections) {
    out.push(`<div><strong>${htmlText(s.heading)}</strong></div>`, `<div>${htmlText(s.text)}</div>`);
    if (s.table) {
      const { header, rows } = s.table;
      out.push(
        '<table>',
        `<thead><tr>${header.map((h) => `<th>${htmlText(h)}</th>`).join('')}</tr></thead>`,
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${htmlText(c)}</td>`).join('')}</tr>`).join('')}</tbody>`,
        '</table>',
      );
    }
    if (s.note) out.push(`<div>${htmlWithCode(s.note)}</div>`);
  }
  return out.join('');
}
