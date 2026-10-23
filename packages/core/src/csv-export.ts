import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ProjectDb } from '@freecrawl/db';
import { urlColumnHeader, type CrawlUrlRow, type UrlCategory } from '@freecrawl/shared-types';
import { escapeCsv } from './spreadsheet.js';
import { inBlocks, writeExportFile } from './export-file.js';

const CSV_COLUMNS: (keyof CrawlUrlRow)[] = [
  'url',
  'isExternal',
  'statusCode',
  'contentKind',
  'indexability',
  'indexabilityReason',
  'title',
  'titleLength',
  'metaDescription',
  'metaDescriptionLength',
  'h1',
  'h2Count',
  'wordCount',
  'mainWordCount',
  'canonical',
  'canonicalHttp',
  'metaRobots',
  'xRobotsTag',
  'contentType',
  'contentLength',
  'responseTimeMs',
  'depth',
  'inlinks',
  'outlinks',
  'redirectTarget',
  'jsH1Changed',
  'jsCanonicalChanged',
  'jsLinksChanged',
  'jsTextChanged',
  'renderDiff',
  'consoleErrors',
  'failedResources',
  'consoleLog',
  'markupErrors',
  'markupCodes',
  'cookiesTotal',
  'cookiesTruncated',
  'cookiesJson',
  'cssBytes',
  'cssUnusedBytes',
  'jsBytes',
  'jsUnusedBytes',
  'crawledAt',
];

// Deliberately the shared implementation, not a local copy. This file had
// its own `escapeCsv` with no formula guard, so a crawled `<title>` or
// anchor text beginning with `=`, `+`, `-` or `@` — both fully controlled
// by the crawled site — was written verbatim and executed by Excel /
// LibreOffice / Sheets on open. Every bulk-export file and every
// context-menu "Export as CSV" went through here, while the Export As…
// dialog used the guarded copy: two writers reachable from one grid, only
// one of them safe.

/**
 * The URL CSV's first chunk (BOM + header row) and its row line, for
 * `columns` (default CSV_COLUMNS). `headers: 'keys'` writes the raw
 * `CrawlUrlRow` keys and turns the formula guard off (machine mode).
 */
export function urlCsvFormat(options: {
  columns?: (keyof CrawlUrlRow)[];
  headers?: 'labels' | 'keys';
}): { head: string; line: (row: CrawlUrlRow) => string } {
  const cols = options.columns && options.columns.length > 0 ? options.columns : CSV_COLUMNS;
  const cell = { formulaGuard: options.headers !== 'keys' };
  const header =
    cols.map((c) => escapeCsv(options.headers === 'keys' ? c : urlColumnHeader(c), cell)).join(',') + '\n';
  return {
    head: '\ufeff' + header,
    line: (row) => cols.map((col) => escapeCsv(row[col], cell)).join(',') + '\n',
  };
}

export async function exportUrlsToCsv(
  db: ProjectDb,
  filePath: string,
  options: {
    selectedIds?: number[];
    category?: UrlCategory;
    /** Column override — appended/replaced per topic so a bulk export's
     *  custom-extraction / hreflang / security files carry their own fields
     *  instead of only the generic column set. Defaults to CSV_COLUMNS. */
    columns?: (keyof CrawlUrlRow)[];
    /** Header row: the grid's column labels (default) or the raw
     *  `CrawlUrlRow` keys for scripts that read the file back. `'keys'` is
     *  machine mode: it also turns the CSV formula guard off, so a
     *  «- text» cell is written as is. */
    headers?: 'labels' | 'keys';
  } = {},
): Promise<{ rowsWritten: number }> {
  let rowsWritten = 0;
  const { head, line } = urlCsvFormat(options);

  const source: Iterable<CrawlUrlRow> =
    options.selectedIds && options.selectedIds.length > 0
      ? db.iterateUrlsByIds(options.selectedIds)
      : options.category && options.category !== 'all'
        ? db.iterateUrlsByCategory(options.category)
        : db.iterateAllUrls();

  const generator = async function* (): AsyncGenerator<string> {
    yield head;
    for (const row of source) {
      rowsWritten++;
      yield line(row);
    }
  };

  await writeExportFile(filePath, (partPath) =>
    pipeline(Readable.from(generator()), createWriteStream(partPath, { encoding: 'utf8' })),
  );

  return { rowsWritten };
}

/** Fixed column order for the Images CSV export. Matches the columns
 *  shown in the Images tab so the file is a 1:1 export of the grid. */
const IMAGES_CSV_HEADER = [
  'Image URL',
  'Alt',
  'Width',
  'Height',
  'Internal',
  'Occurrences',
  'Size (Bytes)',
  'Page',
] as const;

/**
 * Stream every image row to a CSV file. Honours the Images tab's
 * `missingAltOnly` + `search` filters so the export matches what the
 * user is currently looking at. Streamed row-by-row so a 100K-image
 * crawl never builds a giant string in memory.
 */
/** Links CSV columns: header label (the link datasets' names) and the key `headers: 'keys'` writes. */
const LINKS_CSV_COLUMNS: readonly { key: string; label: string }[] = [
  { key: 'fromUrl', label: 'Source' },
  { key: 'toUrl', label: 'Destination' },
  { key: 'toStatusCode', label: 'Status Code' },
  { key: 'anchor', label: 'Anchor' },
  { key: 'rel', label: 'Rel' },
  { key: 'type', label: 'Type' },
  { key: 'target', label: 'Target' },
  { key: 'altText', label: 'Alt Text' },
  { key: 'linkPosition', label: 'Link Position' },
  { key: 'linkPath', label: 'Link Path' },
  { key: 'linkOrigin', label: 'Link Origin' },
];

/**
 * One row per stored link edge — the raw `from → to` table the Bulk
 * Export "Links (Internal / External)" files carry. Streams through the
 * keyset iterator so memory stays flat on million-link sites.
 */
export async function exportLinksToCsv(
  db: ProjectDb,
  filePath: string,
  options: {
    scope: 'internal' | 'external';
    /** Header row: labels (default) or keys; `'keys'` also turns the
     *  formula guard off, like {@link exportUrlsToCsv}. */
    headers?: 'labels' | 'keys';
  },
): Promise<{ rowsWritten: number }> {
  let rowsWritten = 0;
  const cell = { formulaGuard: options.headers !== 'keys' };
  const header =
    LINKS_CSV_COLUMNS.map((c) => (options.headers === 'keys' ? c.key : c.label)).join(',') + '\n';
  const generator = function* (): Generator<string> {
    yield '\ufeff' + header;
    for (const l of db.iterateLinks(options.scope)) {
      const cells = [
        l.from_url,
        l.to_url,
        l.to_status,
        l.anchor,
        l.rel,
        l.type,
        l.target,
        l.alt_text,
        l.link_position,
        l.link_path,
        l.link_origin,
      ];
      rowsWritten++;
      yield cells.map((c) => escapeCsv(c, cell)).join(',') + '\n';
    }
  };
  await writeExportFile(filePath, (partPath) =>
    pipeline(Readable.from(inBlocks(generator())), createWriteStream(partPath, { encoding: 'utf8' })),
  );
  return { rowsWritten };
}

export async function exportImagesToCsv(
  db: ProjectDb,
  filePath: string,
  options: {
    missingAltOnly?: boolean;
    emptyAltOnly?: boolean;
    duplicateAltOnly?: boolean;
    search?: string;
    minByteSize?: number;
  } = {},
): Promise<{ rowsWritten: number }> {
  let rowsWritten = 0;
  const header = IMAGES_CSV_HEADER.join(',') + '\n';

  const generator = async function* (): AsyncGenerator<string> {
    yield '﻿' + header;
    for (const row of db.iterateImages({
      missingAltOnly: options.missingAltOnly,
      emptyAltOnly: options.emptyAltOnly,
      duplicateAltOnly: options.duplicateAltOnly,
      search: options.search,
      minByteSize: options.minByteSize,
    })) {
      const cells = [
        row.src,
        row.alt,
        row.width,
        row.height,
        row.isInternal ? 'internal' : 'external',
        row.occurrences,
        row.byteSize,
        row.fromUrl,
      ];
      rowsWritten++;
      yield cells.map((c) => escapeCsv(c)).join(',') + '\n';
    }
  };

  await writeExportFile(filePath, (partPath) =>
    pipeline(Readable.from(generator()), createWriteStream(partPath, { encoding: 'utf8' })),
  );

  return { rowsWritten };
}

/** Fixed column order for the Broken Links CSV export. */
const BROKEN_LINK_CSV_HEADER = [
  'Source URL',
  'Source Status',
  'Target URL',
  'Target Status',
  'Anchor',
  'Rel',
  'Type',
  'Link Position',
] as const;

/**
 * Stream every broken link (target 4xx/5xx) to a CSV file. Mirrors the
 * Broken Links tab grid; `internal` scopes the export the same way the
 * tab's sidebar filter does. Streamed row-by-row so a large set never
 * builds a big string in memory.
 */
export async function exportBrokenLinksToCsv(
  db: ProjectDb,
  filePath: string,
  options: { internal?: 'all' | 'internal' | 'external'; search?: string } = {},
): Promise<{ rowsWritten: number }> {
  let rowsWritten = 0;
  const header = BROKEN_LINK_CSV_HEADER.join(',') + '\n';

  const generator = async function* (): AsyncGenerator<string> {
    yield '﻿' + header;
    for (const row of db.iterateBrokenLinks(options.internal ?? 'all', options.search)) {
      const cells = [
        row.fromUrl,
        row.fromStatusCode,
        row.toUrl,
        row.toStatusCode,
        row.anchor,
        row.rel,
        row.isInternal ? 'internal' : 'external',
        row.position,
      ];
      rowsWritten++;
      yield cells.map((c) => escapeCsv(c)).join(',') + '\n';
    }
  };

  await writeExportFile(filePath, (partPath) =>
    pipeline(Readable.from(generator()), createWriteStream(partPath, { encoding: 'utf8' })),
  );

  return { rowsWritten };
}
