import { resolveSeoThresholds, type SeoThresholds } from '@freecrawl/shared-types';
import { estimatePixelWidth, META_DESCRIPTION_FONT_PX } from './html-parser.js';
import { escapeCsv } from './spreadsheet.js';

/**
 * SERP-lite (B85): checks pasted titles and descriptions against the Google
 * snippet limits without fetching anything and without storing anything. The
 * widths come from the same function the crawl uses, so a pasted text and a
 * crawled page with the same text never disagree.
 */

export const SERP_MAX_ROWS = 100_000;

export interface SerpInputRow {
  url?: string;
  title: string;
  description: string;
}

/** One status per row for reading; chars are judged before pixels. */
export type SerpStatus =
  | 'ok'
  | 'missing'
  | 'too-short'
  | 'too-long'
  | 'pixel-too-short'
  | 'pixel-too-long';

export interface SerpFlags {
  titleTooShort: boolean;
  titleTooLong: boolean;
  titlePxShort: boolean;
  titlePxLong: boolean;
  descTooShort: boolean;
  descTooLong: boolean;
  descPxShort: boolean;
  descPxLong: boolean;
}

export interface SerpRowResult {
  url: string;
  title: string;
  titleChars: number;
  titlePx: number;
  titleStatus: SerpStatus;
  /** The title up to the last character that fits `titleMaxPx` (the whole title when it fits). */
  titleTruncated: string;
  description: string;
  descChars: number;
  descPx: number;
  descStatus: SerpStatus;
  /** The four independent checks per text, as the crawl keeps them. */
  flags: SerpFlags;
  /** Size of the group of rows with the same text (trimmed, case-folded); 0 when the text is unique or empty. */
  duplicateTitle: number;
  duplicateDescription: number;
}

/** Whitespace runs collapse to one space and the ends are trimmed, as the crawl reads a `<title>`. */
function tidy(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

interface Limits {
  minChars: number;
  maxChars: number;
  minPx: number;
  maxPx: number;
}

function judge(chars: number, px: number, l: Limits) {
  const short = chars > 0 && chars < l.minChars;
  const long = chars > l.maxChars;
  const pxShort = px > 0 && px < l.minPx;
  const pxLong = px > l.maxPx;
  const status: SerpStatus =
    chars === 0
      ? 'missing'
      : short
        ? 'too-short'
        : long
          ? 'too-long'
          : pxShort
            ? 'pixel-too-short'
            : pxLong
              ? 'pixel-too-long'
              : 'ok';
  return { status, short, long, pxShort, pxLong };
}

function truncateToPx(text: string, maxPx: number): string {
  if (estimatePixelWidth(text) <= maxPx) return text;
  let out = '';
  for (const ch of text) {
    if (estimatePixelWidth(out + ch) > maxPx) break;
    out += ch;
  }
  return out;
}

function groupSizes(texts: string[]): number[] {
  const counts = new Map<string, number>();
  const keys = texts.map((t) => t.toLowerCase());
  for (const k of keys) if (k !== '') counts.set(k, (counts.get(k) ?? 0) + 1);
  return keys.map((k) => {
    const n = k === '' ? 0 : (counts.get(k) ?? 0);
    return n > 1 ? n : 0;
  });
}

export function checkSerpRows(
  rows: readonly SerpInputRow[],
  thresholds?: Partial<SeoThresholds> | null,
): SerpRowResult[] {
  if (rows.length > SERP_MAX_ROWS) {
    throw new Error(`Too many rows: ${rows.length} (at most ${SERP_MAX_ROWS})`);
  }
  const t = resolveSeoThresholds(thresholds);
  const titles = rows.map((r) => tidy(r.title));
  const descs = rows.map((r) => tidy(r.description));
  const dupTitle = groupSizes(titles);
  const dupDesc = groupSizes(descs);
  return rows.map((r, i) => {
    const title = titles[i]!;
    const description = descs[i]!;
    const titleChars = Array.from(title).length;
    const descChars = Array.from(description).length;
    const titlePx = estimatePixelWidth(title);
    const descPx = estimatePixelWidth(description, META_DESCRIPTION_FONT_PX);
    const tj = judge(titleChars, titlePx, {
      minChars: t.titleMinChars,
      maxChars: t.titleMaxChars,
      minPx: t.titleMinPx,
      maxPx: t.titleMaxPx,
    });
    const dj = judge(descChars, descPx, {
      minChars: t.descriptionMinChars,
      maxChars: t.descriptionMaxChars,
      minPx: t.descriptionMinPx,
      maxPx: t.descriptionMaxPx,
    });
    return {
      url: r.url ?? '',
      title,
      titleChars,
      titlePx,
      titleStatus: tj.status,
      titleTruncated: truncateToPx(title, t.titleMaxPx),
      description,
      descChars,
      descPx,
      descStatus: dj.status,
      flags: {
        titleTooShort: tj.short,
        titleTooLong: tj.long,
        titlePxShort: tj.pxShort,
        titlePxLong: tj.pxLong,
        descTooShort: dj.short,
        descTooLong: dj.long,
        descPxShort: dj.pxShort,
        descPxLong: dj.pxLong,
      },
      duplicateTitle: dupTitle[i]!,
      duplicateDescription: dupDesc[i]!,
    };
  });
}

// ── Input ────────────────────────────────────────────────────────────

const TITLE_HEADERS = new Set(['title', 'заголовок']);
const DESC_HEADERS = new Set(['description', 'описание']);
const URL_HEADERS = new Set(['url', 'адрес']);

/** RFC 4180 records: quoted fields may hold the delimiter, quotes ("") and line breaks. */
function parseRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRecord = (): void => {
    record.push(field);
    field = '';
    if (record.length > 1 || record[0] !== '') records.push(record);
    record = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      record.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      // CRLF ends the record on the "\n".
    } else if (ch === '\n' || ch === '\r') endRecord();
    else field += ch;
    i++;
  }
  if (field !== '' || record.length > 0) endRecord();
  return records;
}

/**
 * Reads pasted or file text into rows. A first line naming `title` and/or
 * `description` (`заголовок`, `описание`; `url`/`адрес` optional, any order,
 * any case) makes it a CSV or TSV table; otherwise every non-blank line is
 * `title<TAB>description`, and a line without a tab is a title only.
 */
export function parseSerpInput(text: string): SerpInputRow[] {
  const body = text.replace(/^\uFEFF/, '');
  const firstLine = body.split(/\r\n|\n|\r/, 1)[0] ?? '';
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  const names = firstLine.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, '').toLowerCase());
  const col = (set: Set<string>): number => names.findIndex((n) => set.has(n));
  const titleCol = col(TITLE_HEADERS);
  const descCol = col(DESC_HEADERS);
  if (titleCol >= 0 || descCol >= 0) {
    const urlCol = col(URL_HEADERS);
    return parseRecords(body, delimiter)
      .slice(1)
      .map((cells) => {
        const row: SerpInputRow = {
          title: titleCol >= 0 ? (cells[titleCol] ?? '') : '',
          description: descCol >= 0 ? (cells[descCol] ?? '') : '',
        };
        if (urlCol >= 0) row.url = cells[urlCol] ?? '';
        return row;
      });
  }
  const rows: SerpInputRow[] = [];
  for (const line of body.split(/\r\n|\n|\r/)) {
    if (line.trim() === '') continue;
    const tab = line.indexOf('\t');
    rows.push(
      tab < 0
        ? { title: line, description: '' }
        : { title: line.slice(0, tab), description: line.slice(tab + 1) },
    );
  }
  return rows;
}

// ── Output ───────────────────────────────────────────────────────────

export const SERP_CSV_COLUMNS = [
  'url',
  'title',
  'title_chars',
  'title_px',
  'title_status',
  'title_too_short',
  'title_too_long',
  'title_px_short',
  'title_px_long',
  'description',
  'description_chars',
  'description_px',
  'description_status',
  'desc_too_short',
  'desc_too_long',
  'desc_px_short',
  'desc_px_long',
  'duplicate_title',
  'duplicate_description',
] as const;

const bit = (b: boolean): number => (b ? 1 : 0);

/**
 * The report as CSV, rows in input order, through the shared `escapeCsv`
 * (formula guard on). Flags are 0/1; the duplicate columns hold the size of
 * the group, 0 when the text is unique.
 *
 * Duplicates differ from the crawl's "duplicate title" issue: here the
 * texts are trimmed and compared ignoring case (a pasted list is often
 * retyped), while the crawl groups on the exact stored title.
 */
export function serpRowsToCsv(results: readonly SerpRowResult[]): string {
  const lines = [SERP_CSV_COLUMNS.join(',')];
  for (const r of results) {
    const f = r.flags;
    const cells: unknown[] = [
      r.url,
      r.title,
      r.titleChars,
      r.titlePx,
      r.titleStatus,
      bit(f.titleTooShort),
      bit(f.titleTooLong),
      bit(f.titlePxShort),
      bit(f.titlePxLong),
      r.description,
      r.descChars,
      r.descPx,
      r.descStatus,
      bit(f.descTooShort),
      bit(f.descTooLong),
      bit(f.descPxShort),
      bit(f.descPxLong),
      r.duplicateTitle,
      r.duplicateDescription,
    ];
    lines.push(cells.map((c) => escapeCsv(c)).join(','));
  }
  return lines.join('\n') + '\n';
}
