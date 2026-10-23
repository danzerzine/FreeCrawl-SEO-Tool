/**
 * B41: pick the Lighthouse insights, opportunities and diagnostics out of a PageSpeed Insights
 * response. Pure: JSON in, rows out; the HTTP layer stays in the desktop `pagespeed.ts`.
 */
import type {
  PagespeedAuditData,
  PagespeedAuditItem,
  PagespeedAuditKind,
  PagespeedAudits,
} from '@freecrawl/shared-types';

const KIND_BY_GROUP: Record<string, PagespeedAuditKind> = {
  insights: 'insight',
  diagnostics: 'diagnostic',
  // Lighthouse <= 12 called the opportunities this.
  'load-opportunities': 'opportunity',
};

/** Display modes that carry no verdict about the page. */
const SKIPPED_MODES = new Set(['notApplicable', 'error', 'manual']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Savings in ms: the audit's own total, else the largest metric saving, else its duration. */
function savingsMsOf(audit: Record<string, unknown>, details: Record<string, unknown>): number | null {
  const overall = num(details['overallSavingsMs']);
  if (overall !== null) return overall;
  const metric = audit['metricSavings'];
  if (isRecord(metric)) {
    // Savings of different metrics overlap, so the largest one is the honest estimate, not the sum.
    const values = Object.values(metric).filter((v): v is number => num(v) !== null);
    if (values.length > 0) return Math.max(...values);
  }
  return audit['numericUnit'] === 'millisecond' ? num(audit['numericValue']) : null;
}

const MAX_ROWS = 20;
const MAX_JSON_CHARS = 8192;
const MAX_STRING = 300;
const MAX_SNIPPET = 200;
/** How deep inside a `list` the walk goes: entries of the list are level 1, their own lists level 2. */
const MAX_LIST_DEPTH = 2;

function cut(v: string, max = MAX_STRING): string {
  return v.length > max ? v.slice(0, max) : v;
}

/** A string, or the string inside a Lighthouse value object (`{type:'url'|'code'|'text', value}`). */
function text(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (isRecord(v)) {
    if (typeof v['value'] === 'string') return v['value'];
    if (typeof v['url'] === 'string') return v['url'];
  }
  return undefined;
}

function numeric(v: unknown): number | undefined {
  const n = num(isRecord(v) ? v['value'] : v);
  return n === null ? undefined : n;
}

/** Keeps the whitelisted keys of one Lighthouse row, with value objects unwrapped. */
function normalizeRow(raw: Record<string, unknown>, section?: string): PagespeedAuditItem | null {
  const row: PagespeedAuditItem = {};
  const url = text(raw['url']);
  if (url !== undefined) row.url = cut(url);
  const src = raw['source'];
  if (isRecord(src) && typeof src['url'] === 'string') {
    const line = num(src['line']);
    row.source = cut(line === null ? src['url'] : `${src['url']}:${line + 1}`);
  } else {
    const s = text(src);
    if (s !== undefined) row.source = cut(s);
  }
  for (const key of ['wastedMs', 'wastedBytes', 'totalBytes'] as const) {
    const n = numeric(raw[key]);
    if (n !== undefined) row[key] = n;
  }
  // A node is `{type:'node', selector, snippet}`; some rows carry the two keys directly.
  const node = isRecord(raw['node']) ? raw['node'] : raw;
  const selector = text(node['selector']);
  if (selector !== undefined) row.selector = cut(selector);
  const snippet = text(node['snippet']);
  if (snippet !== undefined) row.snippet = cut(snippet, MAX_SNIPPET);
  const label = text(raw['label']);
  if (label !== undefined) row.label = cut(label);
  if (Object.keys(row).length === 0) return null;
  if (section !== undefined) row.section = section;
  return row;
}

function tableRows(items: unknown, section?: string): PagespeedAuditItem[] {
  if (!Array.isArray(items)) return [];
  const rows: PagespeedAuditItem[] = [];
  for (const raw of items) {
    const row = isRecord(raw) ? normalizeRow(raw, section) : null;
    if (row) rows.push(row);
  }
  return rows;
}

/** A checklist keeps its `{label, value}` booleans; `items` is an object keyed by name (or an array). */
function checklistRows(items: unknown, section?: string): PagespeedAuditItem[] {
  const entries = Array.isArray(items) ? items : isRecord(items) ? Object.values(items) : [];
  const rows: PagespeedAuditItem[] = [];
  for (const e of entries) {
    if (!isRecord(e) || typeof e['value'] !== 'boolean') continue;
    const label = text(e['label']);
    if (label === undefined) continue;
    const row: PagespeedAuditItem = { label: cut(label), value: e['value'] };
    if (section !== undefined) row.section = section;
    rows.push(row);
  }
  return rows;
}

function listRows(entries: unknown[], depth: number, prefix: string): PagespeedAuditItem[] {
  const rows: PagespeedAuditItem[] = [];
  entries.forEach((entry, i) => {
    if (!isRecord(entry)) return;
    const type = entry['type'];
    const section = `${prefix}${i}:${typeof type === 'string' ? type : '?'}`;
    if (type === 'table') rows.push(...tableRows(entry['items'], section));
    else if (type === 'checklist') rows.push(...checklistRows(entry['items'], section));
    else if (type === 'node') {
      const row = normalizeRow(entry, section);
      if (row) rows.push(row);
    } else if (type === 'list' && depth < MAX_LIST_DEPTH && Array.isArray(entry['items'])) {
      rows.push(...listRows(entry['items'], depth + 1, `${prefix}${i}.`));
    }
    // Anything else (`list-section`, a network tree, an unknown type) holds no rows we can read.
  });
  return rows;
}

/** Every readable resource row of an audit, uncapped. An unknown shape yields none. */
function allRows(details: Record<string, unknown>): PagespeedAuditItem[] {
  const items = details['items'];
  if (details['type'] === 'checklist') return checklistRows(items);
  if (!Array.isArray(items)) return [];
  if (details['type'] === 'list') return listRows(items, 1, '');
  return tableRows(items);
}

/** Savings in bytes: the audit's own total, else the sum of its rows' `wastedBytes` (Lighthouse 13
 *  insights carry no total), else unknown (`null`, never 0). */
function savingsBytesOf(details: Record<string, unknown>, rows: PagespeedAuditItem[]): number | null {
  const overall = num(details['overallSavingsBytes']);
  if (overall !== null) return overall;
  let sum: number | null = null;
  for (const row of rows) {
    if (row.wastedBytes !== undefined) sum = (sum ?? 0) + row.wastedBytes;
  }
  return sum;
}

/** At most 20 rows and 8 KB of JSON; rows go from the end. */
function capRows(rows: PagespeedAuditItem[]): { items: PagespeedAuditItem[]; truncated: boolean } {
  let items = rows.slice(0, MAX_ROWS);
  let truncated = rows.length > MAX_ROWS;
  while (items.length > 0 && JSON.stringify(items).length > MAX_JSON_CHARS) {
    items = items.slice(0, -1);
    truncated = true;
  }
  return { items, truncated };
}

export function parsePagespeedAudits(json: unknown): PagespeedAudits {
  const root = isRecord(json) ? json : {};
  // The PSI response wraps the report as `lighthouseResult`; a bare report is accepted too.
  const lhr = isRecord(root['lighthouseResult']) ? root['lighthouseResult'] : root;
  const version = lhr['lighthouseVersion'];
  const lighthouseVersion = typeof version === 'string' ? version : null;
  const audits = isRecord(lhr['audits']) ? lhr['audits'] : {};
  const perf = isRecord(lhr['categories']) ? lhr['categories']['performance'] : undefined;
  const refs = isRecord(perf) && Array.isArray(perf['auditRefs']) ? perf['auditRefs'] : [];

  const out: PagespeedAuditData[] = [];
  for (const ref of refs) {
    if (!isRecord(ref)) continue;
    const group = typeof ref['group'] === 'string' ? ref['group'] : '';
    const kind = KIND_BY_GROUP[group];
    const id = ref['id'];
    if (!kind || typeof id !== 'string') continue;
    const audit = audits[id];
    if (!isRecord(audit)) continue;
    const mode = audit['scoreDisplayMode'];
    if (typeof mode === 'string' && SKIPPED_MODES.has(mode)) continue;
    const score = num(audit['score']);
    const details = isRecord(audit['details']) ? audit['details'] : {};
    const rows = allRows(details);
    const savingsMs = savingsMsOf(audit, details);
    const savingsBytes = savingsBytesOf(details, rows);
    const capped = capRows(rows);
    const failing = score !== null && score < 1;
    if (!failing && !((savingsMs ?? 0) > 0 || (savingsBytes ?? 0) > 0)) continue;
    out.push({
      auditId: id,
      kind,
      title: typeof audit['title'] === 'string' ? audit['title'] : id,
      score,
      displayValue: typeof audit['displayValue'] === 'string' ? audit['displayValue'] : null,
      savingsMs,
      savingsBytes,
      items: capped.items,
      itemsTruncated: capped.truncated,
    });
  }
  return { lighthouseVersion, audits: out };
}
