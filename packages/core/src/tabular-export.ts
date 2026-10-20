import { createWriteStream, mkdirSync } from 'node:fs';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ProjectDb } from '@freecrawl/db';
import type {
  CrawlUrlRow,
  UrlCategory,
  AdvancedFilter,
  ExportDatasetKey,
} from '@freecrawl/shared-types';
import { escapeCsv } from './spreadsheet.js';
import { datasetRows, readCell, type DatasetExportContext } from './dataset-export.js';

/** How a section selects its rows. `selectedIds` wins; otherwise category is
 *  narrowed by the active search/filter so the export matches the grid. */
interface RowQuery {
  category: UrlCategory;
  selectedIds?: number[];
  search?: string;
  filter?: AdvancedFilter;
}

export interface TabularSection {
  label: string;
  /** URL category to stream `CrawlUrlRow`s from. Required unless `dataset` is set. */
  category?: UrlCategory;
  /** Non-URL-row table (Search Console, Broken Links, …) — see `datasetRows`. */
  dataset?: ExportDatasetKey;
  /** Column keys for this section only; defaults to the export-wide `columns`. */
  columns?: string[];
  /** Optional sub-directory under the export root (for hierarchical
   *  tree exports — e.g. `Internal` → HTML / JS / CSS land under
   *  `internal/`). Ignored for xlsx output. */
  subdir?: string;
  /** Optional filename stem (without extension). Defaults to a
   *  sanitized version of `label`. */
  filename?: string;
}

export interface TabularExportOptions {
  format: 'csv' | 'xlsx' | 'json' | 'jsonl' | 'xml';
  sections: TabularSection[];
  /** Keys of CrawlUrlRow to include, in order. */
  columns: string[];
  /** When provided AND non-empty, restrict every section to these row ids. */
  selectedIds?: number[];
  /** Active URL-table search — applied to every section (ignored when
   *  `selectedIds` is set) so the export matches the filtered grid. */
  search?: string;
  /** Active advanced filter — same rationale as `search`. */
  filter?: AdvancedFilter;
  /** Prefix CSV files with a UTF-8 BOM so Excel-for-Windows opens them
   *  in the correct charset. Ignored for non-CSV formats. Default true. */
  csvBom?: boolean;
  /** Account / matching context for the dataset sections that need it. */
  datasetContext?: DatasetExportContext;
}

export interface TabularExportResult {
  /** File (xlsx / single-section csv) or folder (multi-section csv). */
  filePath: string;
  files: string[];
  rowsWritten: number;
  /** Sections that held nothing, so no file was written, with the reason. */
  skipped?: { label: string; reason: string }[];
}

/**
 * Datasets that are big and depend on what the crawl chose to store: when
 * they hold no rows the export writes no file (an empty file would read as
 * "the site has none") and says why instead.
 */
const EMPTY_DATASET_REASONS: Partial<Record<ExportDatasetKey, string>> = {
  'response-headers': 'No response headers are stored for this crawl.',
  'page-html':
    'No page HTML is stored: the crawl ran with storeBodySnapshots off, or it fetched no HTML pages.',
  'page-text':
    'No page text is available: it is read from the stored page HTML, and the crawl ran with storeBodySnapshots off or fetched no HTML pages.',
};

/**
 * Bug #9 — Formula injection guard. Excel + LibreOffice + Google Sheets
 * interpret cells beginning with `=`, `+`, `-`, `@`, or a TAB/CR as
 * formulas (CVE-class). When the source data is crawled HTML (titles,
 * extraction values, anchor text), an attacker can craft a page whose
 * title is e.g. `=cmd|'/c calc'!A1` and have it execute when the user
 * opens the export. We neutralise by prepending a single quote — the
 * canonical CSV-injection mitigation per OWASP. The apostrophe is
 * visible in Excel only when the user is editing the cell.
 */
/**
 * Excel's hard limit on characters in one cell. Exceed it and Excel
 * declares the workbook corrupt ("We found a problem with some content…")
 * and silently drops the record when the user clicks Repair — so the cell
 * that mattered most is the one that disappears. Reachable today from the
 * Structured Data grid export, which writes whole raw JSON-LD blocks.
 */
const XLSX_MAX_CELL_CHARS = 32_767;

/** Render one text cell for a worksheet.
 *
 *  No formula guard here, deliberately. In SpreadsheetML a cell is a
 *  formula only if it carries an `<f>` child; `t="inlineStr"` content is
 *  never evaluated. Prefixing it with `'` therefore protected nothing and
 *  corrupted real values — a title like `-50% İndirim Fırsatı` reached the
 *  user as `'-50% İndirim Fırsatı`. (XLSX being inert this way is exactly
 *  why it is the recommended mitigation for CSV injection.)
 *
 *  `xml:space="preserve"` keeps leading/trailing spaces, which Excel
 *  otherwise trims — and padded anchor text is itself a finding this tool
 *  reports, so silently trimming it destroys the evidence.
 */
function inlineStrCell(cellRef: string, value: unknown): string {
  let text = String(value);
  if (text.length > XLSX_MAX_CELL_CHARS) {
    text = text.slice(0, XLSX_MAX_CELL_CHARS - 1) + '…';
  }
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${cellRef}" t="inlineStr"><is><t${preserve}>${xmlEscape(text)}</t></is></c>`;
}

function rowSource(db: ProjectDb, q: RowQuery): Iterable<CrawlUrlRow> {
  if (q.selectedIds && q.selectedIds.length > 0) {
    // Apply selectedIds first, then narrow by category client-side. The
    // sidebar's category predicates can be expensive; for export the
    // selection is always the small side. (An explicit selection overrides
    // the search/filter — the user picked exact rows.)
    const ids = new Set(q.selectedIds);
    return (function* () {
      for (const row of db.iterateUrlsByCategory(q.category)) {
        if (ids.has(row.id)) yield row;
      }
    })();
  }
  // Honour the active search / advanced filter so the export mirrors the
  // on-screen grid rather than the whole category.
  if (q.search || q.filter) {
    return db.iterateUrlsByQuery({
      category: q.category,
      search: q.search,
      filter: q.filter,
    });
  }
  return db.iterateUrlsByCategory(q.category);
}

async function writeCsvFile(
  source: Iterable<Record<string, unknown>>,
  filePath: string,
  columns: string[],
  withBom: boolean,
): Promise<number> {
  let rowsWritten = 0;
  // Escape the header row too: a column label containing a comma, quote or
  // leading `=`/`+`/`-`/`@` would otherwise break the CSV or inject a
  // formula. The data rows below already go through escapeCsv.
  const header = columns.map((c) => escapeCsv(c)).join(',') + '\n';
  const generator = async function* (): AsyncGenerator<string> {
    if (withBom) yield '﻿' + header;
    else yield header;
    for (const row of source) {
      const line =
        columns
          .map((c) => escapeCsv(readCell(row, c)))
          .join(',') + '\n';
      rowsWritten++;
      yield line;
    }
  };
  await pipeline(
    Readable.from(generator()),
    createWriteStream(filePath, { encoding: 'utf8' }),
  );
  return rowsWritten;
}

function escapeXml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return (
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // Characters XML 1.0 forbids outright — escaping does NOT make them
      // legal. One page whose title carries an interior control char (they
      // arrive via numeric HTML entities and survive `.trim()`) made the
      // whole document unparseable, so every consumer saw zero rows from a
      // single bad page. `xmlEscape` below already strips these; this
      // escaper was simply missing it.
      // eslint-disable-next-line no-control-regex -- intentionally matching control chars to strip them
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  );
}

function xmlSafeTag(name: string): string {
  // Replace anything non-NCName-friendly with `_`. Numeric-leading keys
  // are prefixed with `n` so the doc stays well-formed.
  let safe = name.replace(/[^A-Za-z0-9_.-]/g, '_');
  if (/^[0-9]/.test(safe)) safe = `n${safe}`;
  return safe || '_';
}

async function writeJsonFile(
  source: Iterable<Record<string, unknown>>,
  filePath: string,
  columns: string[],
): Promise<number> {
  let rowsWritten = 0;
  const generator = async function* (): AsyncGenerator<string> {
    yield '[';
    let first = true;
    for (const row of source) {
      const obj: Record<string, unknown> = {};
      for (const c of columns) {
        obj[c] = readCell(row, c) ?? null;
      }
      yield (first ? '\n  ' : ',\n  ') + JSON.stringify(obj);
      first = false;
      rowsWritten++;
    }
    yield first ? ']\n' : '\n]\n';
  };
  await pipeline(
    Readable.from(generator()),
    createWriteStream(filePath, { encoding: 'utf8' }),
  );
  return rowsWritten;
}

/** JSON Lines: one object per row, so a reader can stream it and page HTML is not squeezed into a cell. */
async function writeJsonlFile(
  source: Iterable<Record<string, unknown>>,
  filePath: string,
  columns: string[],
): Promise<number> {
  let rowsWritten = 0;
  const generator = async function* (): AsyncGenerator<string> {
    for (const row of source) {
      const obj: Record<string, unknown> = {};
      for (const c of columns) obj[c] = readCell(row, c) ?? null;
      rowsWritten++;
      yield JSON.stringify(obj) + '\n';
    }
  };
  await pipeline(
    Readable.from(generator()),
    createWriteStream(filePath, { encoding: 'utf8' }),
  );
  return rowsWritten;
}

async function writeXmlFile(
  source: Iterable<Record<string, unknown>>,
  filePath: string,
  columns: string[],
  sectionLabel: string,
): Promise<number> {
  let rowsWritten = 0;
  const rootTag = xmlSafeTag(sectionLabel) || 'export';
  const cols = columns.map((c) => ({ key: c, tag: xmlSafeTag(c) }));
  const generator = async function* (): AsyncGenerator<string> {
    yield `<?xml version="1.0" encoding="UTF-8"?>\n<${rootTag}>\n`;
    for (const row of source) {
      yield '  <row>\n';
      for (const { key, tag } of cols) {
        const v = readCell(row, key);
        if (v === null || v === undefined) continue;
        yield `    <${tag}>${escapeXml(v)}</${tag}>\n`;
      }
      yield '  </row>\n';
      rowsWritten++;
    }
    yield `</${rootTag}>\n`;
  };
  await pipeline(
    Readable.from(generator()),
    createWriteStream(filePath, { encoding: 'utf8' }),
  );
  return rowsWritten;
}

// Windows reserved device names — writing to `con.csv` etc. targets the
// console/printer device, not a file. Rejected in both helpers.
const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitizeSegment(seg: string): string {
  const cleaned = seg
    // eslint-disable-next-line no-control-regex -- deliberately stripping control chars from a filename
    .replace(/[\\/?*[\]:<>|"\x00-\x1f]/g, '_')
    .replace(/\s+/g, '-')
    .toLowerCase();
  return WINDOWS_DEVICE_NAMES.test(cleaned) ? `_${cleaned}` : cleaned;
}

function sanitizeFilename(label: string): string {
  const cleaned = sanitizeSegment(label);
  // A bare `.`/`..` (or one that sanitised down to that) must never become a
  // filename — strip leading/trailing dots.
  const stripped = cleaned.replace(/^\.+|\.+$/g, '');
  return stripped.length > 0 ? stripped : 'export';
}

function sanitizeSubdir(subdir: string): string {
  // Sanitize each path segment individually so a hierarchical export like
  // 'crawl-data/internal' stays nested rather than collapsing into one
  // filename component. `.`/`..` segments are dropped so a caller-supplied
  // `../../etc` cannot escape the chosen output root (path traversal).
  return subdir
    .split(/[\\/]+/)
    .filter((seg) => seg !== '.' && seg !== '..')
    .map(sanitizeSegment)
    .filter((seg) => seg.length > 0)
    .join(path.sep);
}

// ── Minimal XLSX writer ─────────────────────────────────────────────
//
// Office Open XML SpreadsheetML, packaged as a ZIP with DEFLATE entries.
// Uses inline strings (no shared-string table) — slightly fatter on disk
// but lets us stream-build sheet XML row-by-row without a second pass.
//
// Worksheet shape:
//   <worksheet><sheetData>
//     <row r="1"><c r="A1" t="inlineStr"><is><t>URL</t></is></c>...</row>
//     <row r="2"><c r="A2" t="inlineStr"><is><t>https://...</t></is></c>...</row>
//   </sheetData></worksheet>
//
// Numbers go in as <c><v>123</v></c> (no `t=` attribute, default = number).

function xmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // strip control chars XML 1.0 forbids
    // eslint-disable-next-line no-control-regex -- intentionally matching control chars to strip them
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function colLetter(idx: number): string {
  // 0-based → A, B, ..., Z, AA, AB, ...
  let n = idx;
  let s = '';
  while (true) {
    const r = n % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return s;
}

function sanitizeSheetName(label: string, used: Set<string>): string {
  let base = label.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31);
  if (!base) base = 'Sheet';
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${i++})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// ── Streaming XLSX writer ───────────────────────────────────────────
//
// The workbook is written straight to disk, one zip entry at a time:
// each worksheet's XML is generated row by row and piped through
// DEFLATE into the file, so memory stays flat no matter how many rows
// a section has (building the whole workbook as one buffer took
// 930 MB for 73k rows × 8 columns and could not hold 300k × 40 at all).
// The local header of each entry is written with zero sizes first and
// patched in place once the entry is done — the output is a file, so
// no data descriptor is needed and the zip stays as plain as before.

/** Data rows per worksheet. Excel stops at 1,048,576 rows including the
 *  header; a round million leaves headroom, and the rest of a section
 *  continues on `<name> (2)`, `<name> (3)`, … */
const XLSX_MAX_DATA_ROWS = 1_000_000;

/** Uncompressed bytes per worksheet XML before it is continued on the
 *  next sheet: zip entries without ZIP64 cap sizes at 4 GiB. Only very
 *  wide or text-heavy sections get here before the row cap. */
const XLSX_MAX_SHEET_XML_BYTES = 3.5 * 1024 ** 3;

/** Worksheet XML is handed to DEFLATE in chunks of about this size. */
const XLSX_CHUNK_CHARS = 256 * 1024;

const ZIP32_MAX = 0xffffffff;

interface XlsxSheetSource {
  name: string;
  headers: readonly string[];
  /** Row cells, aligned to `headers`. Consumed once, lazily. */
  rows: Iterable<readonly unknown[]>;
}

interface ZipCentralEntry {
  nameBuf: Buffer;
  crc: number;
  compressedSize: number;
  rawSize: number;
  offset: number;
}

/** Sequential zip writer over an open file: DEFLATE entries, central
 *  directory at the end. */
class ZipFileWriter {
  private readonly entries: ZipCentralEntry[] = [];
  private pos = 0;

  constructor(private readonly fh: FileHandle) {}

  private async write(buf: Buffer): Promise<void> {
    await this.fh.write(buf, 0, buf.length, this.pos);
    this.pos += buf.length;
    if (this.pos > ZIP32_MAX) {
      throw new Error('XLSX export: workbook exceeds 4 GB — export this data as CSV');
    }
  }

  async add(name: string, chunks: Iterable<string>): Promise<void> {
    const nameBuf = Buffer.from(name, 'utf8');
    const offset = this.pos;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header sig
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // gp flag (UTF-8 name)
    header.writeUInt16LE(8, 8); // method = deflate
    header.writeUInt16LE(nameBuf.length, 26);
    // mod time/date, crc and sizes stay 0 until the entry is written.
    await this.write(header);
    await this.write(nameBuf);

    let crc = 0;
    let rawSize = 0;
    let compressedSize = 0;
    await pipeline(
      Readable.from(
        (function* () {
          for (const chunk of chunks) {
            const buf = Buffer.from(chunk, 'utf8');
            crc = zlib.crc32(buf, crc);
            rawSize += buf.length;
            yield buf;
          }
        })(),
      ),
      zlib.createDeflateRaw(),
      async (compressed: AsyncIterable<Buffer>) => {
        for await (const buf of compressed) {
          await this.write(buf);
          compressedSize += buf.length;
        }
      },
    );
    if (rawSize > ZIP32_MAX) {
      throw new Error(`XLSX export: ${name} exceeds 4 GB — export this data as CSV`);
    }
    const sizes = Buffer.alloc(12);
    sizes.writeUInt32LE(crc, 0);
    sizes.writeUInt32LE(compressedSize, 4);
    sizes.writeUInt32LE(rawSize, 8);
    await this.fh.write(sizes, 0, sizes.length, offset + 14);
    this.entries.push({ nameBuf, crc, compressedSize, rawSize, offset });
  }

  async finish(): Promise<void> {
    const cdStart = this.pos;
    for (const e of this.entries) {
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); // central dir sig
      cd.writeUInt16LE(20, 4); // version made by
      cd.writeUInt16LE(20, 6); // version needed
      cd.writeUInt16LE(0x0800, 8); // gp flag
      cd.writeUInt16LE(8, 10); // method
      cd.writeUInt32LE(e.crc, 16);
      cd.writeUInt32LE(e.compressedSize, 20);
      cd.writeUInt32LE(e.rawSize, 24);
      cd.writeUInt16LE(e.nameBuf.length, 28);
      cd.writeUInt32LE(e.offset, 42);
      await this.write(cd);
      await this.write(e.nameBuf);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(this.pos - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    await this.write(eocd);
  }
}

/** One worksheet row: number → `<v>`, boolean → `t="b"`, anything else an
 *  inline string; empty cells are left out. */
function rowXml(cells: readonly unknown[], r: number): string {
  let xml = `<row r="${r}">`;
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];
    if (v === null || v === undefined || v === '') continue;
    const cellRef = `${colLetter(i)}${r}`;
    if (typeof v === 'number' && Number.isFinite(v)) {
      xml += `<c r="${cellRef}"><v>${v}</v></c>`;
    } else if (typeof v === 'boolean') {
      xml += `<c r="${cellRef}" t="b"><v>${v ? 1 : 0}</v></c>`;
    } else {
      xml += inlineStrCell(cellRef, v);
    }
  }
  return xml + '</row>';
}

/**
 * Write a workbook to `filePath`, one worksheet per source. A source with
 * more than {@link XLSX_MAX_DATA_ROWS} rows continues on `<name> (2)`,
 * `<name> (3)`, … — each with the header row again. Returns data rows
 * written.
 */
async function writeXlsxFile(filePath: string, sources: XlsxSheetSource[]): Promise<number> {
  const fh = await open(filePath, 'w');
  try {
    const zip = new ZipFileWriter(fh);
    const used = new Set<string>();
    const sheetNames: string[] = [];
    let total = 0;
    for (const source of sources) {
      const base = sanitizeSheetName(source.name, used);
      // Header row: also frozen, so it stays on screen while scrolling.
      const head =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetViews><sheetView workbookViewId="0">' +
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
        '</sheetView></sheetViews><sheetData>' +
        `<row r="1">${source.headers
          .map((h, i) => `<c r="${colLetter(i)}1" t="inlineStr"><is><t>${xmlEscape(h)}</t></is></c>`)
          .join('')}</row>`;
      const it = source.rows[Symbol.iterator]();
      let next = it.next();
      let part = 1;
      // Always one sheet (header only when there are no rows); another
      // only while rows remain.
      do {
        let name = base;
        if (part > 1) {
          const suffix = ` (${part})`;
          name = sanitizeSheetName(base.slice(0, 31 - suffix.length) + suffix, used);
        }
        sheetNames.push(name);
        let rowsInSheet = 0;
        await zip.add(
          `xl/worksheets/sheet${sheetNames.length}.xml`,
          (function* () {
            let buf = head;
            let bytes = 0;
            while (
              !next.done &&
              rowsInSheet < XLSX_MAX_DATA_ROWS &&
              bytes < XLSX_MAX_SHEET_XML_BYTES
            ) {
              buf += rowXml(next.value, rowsInSheet + 2);
              rowsInSheet++;
              next = it.next();
              if (buf.length >= XLSX_CHUNK_CHARS) {
                bytes += Buffer.byteLength(buf, 'utf8');
                yield buf;
                buf = '';
              }
            }
            yield buf + '</sheetData></worksheet>';
          })(),
        );
        total += rowsInSheet;
        part++;
      } while (!next.done);
    }

    // Package parts go after the sheets: only now is the sheet list known.
    await zip.add('xl/workbook.xml', [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets>' +
        sheetNames
          .map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join('') +
        '</sheets></workbook>',
    ]);
    await zip.add('xl/_rels/workbook.xml.rels', [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheetNames
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        '</Relationships>',
    ]);
    await zip.add('_rels/.rels', [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ]);
    await zip.add('[Content_Types].xml', [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheetNames
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '</Types>',
    ]);
    await zip.finish();
    return total;
  } finally {
    await fh.close();
  }
}

function resolveSectionPath(
  outputRoot: string,
  section: TabularSection,
  ext: string,
): string {
  const stem = section.filename
    ? sanitizeFilename(section.filename)
    : sanitizeFilename(section.label) || 'section';
  const subdir = section.subdir ? sanitizeSubdir(section.subdir) : '';
  const dir = subdir ? path.join(outputRoot, subdir) : outputRoot;
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${stem}.${ext}`);
}

export async function exportTabular(
  db: ProjectDb,
  outputPath: string,
  options: TabularExportOptions,
): Promise<TabularExportResult> {
  const { format, sections, columns, selectedIds } = options;
  const csvBom = options.csvBom !== false;
  // Build the per-section query once: an explicit selection overrides the
  // search/filter (the user picked exact rows), otherwise the active grid
  // search + advanced filter apply so the export mirrors the view.
  const queryFor = (category: UrlCategory): RowQuery =>
    selectedIds && selectedIds.length > 0
      ? { category, selectedIds }
      : { category, search: options.search, filter: options.filter };
  if (sections.length === 0) {
    throw new Error('exportTabular: at least one section is required');
  }
  // Every section resolves its own row source and column list: URL
  // categories stream CrawlUrlRows over the shared `columns`; datasets
  // (Search Console, Broken Links, …) walk their own query with the
  // per-section keys the dialog picked for them.
  const columnsFor = (section: TabularSection): string[] => section.columns ?? columns;
  const sourceFor = (section: TabularSection): Iterable<Record<string, unknown>> => {
    if (section.dataset) return datasetRows(db, section.dataset, options.datasetContext);
    if (!section.category) {
      throw new Error(`exportTabular: section '${section.label}' needs a category or a dataset`);
    }
    return rowSource(db, queryFor(section.category)) as Iterable<Record<string, unknown>>;
  };
  for (const section of sections) {
    if (columnsFor(section).length === 0) {
      throw new Error(`exportTabular: section '${section.label}' has no columns`);
    }
  }

  if (format === 'xlsx') {
    // xlsx — single workbook, one sheet per section (continued on
    // `<label> (2)`, … past Excel's row limit). subdir/filename are
    // ignored; the workbook lives at `outputPath`. Rows stream from the
    // database into the zip like the CSV/JSON/XML writers below.
    const rowsWritten = await writeXlsxFile(
      outputPath,
      sections.map((section) => {
        const sheetColumns = columnsFor(section);
        return {
          name: section.label,
          headers: sheetColumns,
          // Lazy: a section's query starts only when its sheet is written.
          rows: (function* () {
            for (const row of sourceFor(section)) {
              yield sheetColumns.map((col) => readCell(row, col));
            }
          })(),
        };
      }),
    );
    return { filePath: outputPath, files: [outputPath], rowsWritten };
  }

  // CSV / JSON / XML — file-per-section. When the export has only one
  // section with no subdir, `outputPath` is treated as the file path
  // directly (backwards compatible with the legacy single-CSV flow).
  const ext = format;
  const singleFlat =
    sections.length === 1 &&
    !sections[0]!.subdir &&
    !sections[0]!.filename &&
    /\.[a-z0-9]+$/i.test(outputPath);
  // Bug #11 — force the resolved path's extension to match `format` so a
  // user-typed "report.txt" with format=json doesn't silently write JSON
  // into the wrong extension. Only applies to the single-file branch
  // (folder mode always names its own files).
  const resolvedOutputPath = singleFlat
    ? outputPath.replace(/\.[a-z0-9]+$/i, `.${ext}`)
    : outputPath;

  const writeOne = async (filePath: string, section: TabularSection): Promise<number> => {
    const source = sourceFor(section);
    const sectionColumns = columnsFor(section);
    if (format === 'csv') {
      return writeCsvFile(source, filePath, sectionColumns, csvBom);
    }
    if (format === 'json') {
      return writeJsonFile(source, filePath, sectionColumns);
    }
    if (format === 'jsonl') {
      return writeJsonlFile(source, filePath, sectionColumns);
    }
    return writeXmlFile(source, filePath, sectionColumns, section.label);
  };

  const skipped: { label: string; reason: string }[] = [];
  /** Write one section; an empty size-dependent dataset leaves no file. */
  const writeSection = async (filePath: string, section: TabularSection): Promise<number | null> => {
    const rows = await writeOne(filePath, section);
    const reason = section.dataset ? EMPTY_DATASET_REASONS[section.dataset] : undefined;
    if (rows === 0 && reason) {
      await unlink(filePath).catch(() => undefined);
      skipped.push({ label: section.label, reason });
      return null;
    }
    return rows;
  };

  if (singleFlat) {
    const rows = await writeSection(resolvedOutputPath, sections[0]!);
    return {
      filePath: resolvedOutputPath,
      files: rows === null ? [] : [resolvedOutputPath],
      rowsWritten: rows ?? 0,
      ...(skipped.length > 0 ? { skipped } : {}),
    };
  }

  // Multi-section (or hierarchical) — outputPath is a folder root.
  mkdirSync(outputPath, { recursive: true });
  let total = 0;
  const written: string[] = [];
  for (const section of sections) {
    const file = resolveSectionPath(outputPath, section, ext);
    const rows = await writeSection(file, section);
    if (rows === null) continue;
    total += rows;
    written.push(file);
  }
  return {
    filePath: outputPath,
    files: written,
    rowsWritten: total,
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}

// ── Detail-panel grid export ────────────────────────────────────────
//
// The URL Details panel's sub-tabs (Inlinks, Images, HTTP Headers,
// Cookies, …) each show a small table that is already formatted for
// display — the rows are strings the renderer computed, not database
// records. `exportTabular` above can't serve them: it streams straight
// from `ProjectDb` over `CrawlUrlRow` columns. This writer takes the
// literal cells instead, and reuses the same CSV escaping, formula-
// injection guard and XLSX packaging so a detail-panel export is
// indistinguishable from a main-table one.

export interface GridExportOptions {
  format: 'csv' | 'xlsx';
  /** Column headers, in order. */
  headers: readonly string[];
  /** Row cells, aligned to `headers`. */
  rows: readonly (readonly unknown[])[];
  /** Worksheet name (xlsx only). Sanitised to Excel's 31-char rules. */
  sheetName?: string;
  /** Prefix CSV with a UTF-8 BOM so Excel-for-Windows picks UTF-8. */
  csvBom?: boolean;
}

export interface GridExportResult {
  filePath: string;
  rowsWritten: number;
}

/** Write one in-memory grid to a CSV or XLSX file. */
export async function exportGrid(
  filePath: string,
  options: GridExportOptions,
): Promise<GridExportResult> {
  const { format, headers, rows } = options;
  mkdirSync(path.dirname(filePath), { recursive: true });

  if (format === 'xlsx') {
    const rowsWritten = await writeXlsxFile(filePath, [
      { name: options.sheetName ?? 'Sheet1', headers, rows },
    ]);
    return { filePath, rowsWritten };
  }

  const withBom = options.csvBom !== false;
  const generator = async function* (): AsyncGenerator<string> {
    const header = headers.map((h) => escapeCsv(h)).join(',') + '\n';
    yield withBom ? '﻿' + header : header;
    for (const row of rows) {
      yield row.map((cell) => escapeCsv(cell)).join(',') + '\n';
    }
  };
  await pipeline(
    Readable.from(generator()),
    createWriteStream(filePath, { encoding: 'utf8' }),
  );
  return { filePath, rowsWritten: rows.length };
}

