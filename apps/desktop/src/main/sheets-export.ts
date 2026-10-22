/**
 * Faz 7 — Google Sheets export.
 *
 * Creates a new spreadsheet on the connected Google account's Drive,
 * writes a key set of columns for the chosen URL category, and returns
 * the spreadsheet URL. Auth runs through the shared OAuth keystone
 * (`getAccessToken('sheets')`).
 *
 * One dataset on one sheet per export. Rows are read from the iterator in
 * batches (at most 5 000 rows and 1.5 MB of JSON each) and written with
 * `values.update` at explicit A1 ranges, never `append`: a retried update
 * lands on the same cells, a retried append that had already landed would
 * duplicate the block. The grid is created and grown to exactly the rows
 * written plus the next batch, with exactly as many columns as the dataset
 * has, so the 10 million cell limit of a spreadsheet is the real cap; past
 * it the export stops and the result says `truncated`.
 *
 * Failure: the token scope is `spreadsheets`, which cannot delete a Drive
 * file (that needs `drive.file`, and a new scope makes every connected
 * user consent again). So a spreadsheet left half-written is renamed
 * «FAILED export (partial)» and the error carries its URL.
 */
import type { ProjectDb } from '@freecrawl/db';
import type { CrawlUrlRow, UrlCategory } from '@freecrawl/shared-types';
import { getAccessToken } from './google-oauth.js';
import { apiFetch } from './api-fetch.js';
import * as logger from './logger.js';
import { GoogleAuthError, googleRequest, type GoogleDeps } from './google-retry.js';
import { datasetTable, type GoogleExportDataset, type RawCell } from './google-export-rows.js';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
/** Cells a whole spreadsheet may hold, all tabs together. */
const SHEET_CELL_LIMIT = 10_000_000;
const BATCH_ROWS = 5_000;
/** Google advises at most 2 MB per request; counted in UTF-8 bytes (Cyrillic is 2 per letter). */
const BATCH_BYTES = 1_500_000;
const FAILED_TITLE = 'FreeCrawl — FAILED export (partial)';

/** Data rows (header excluded) a spreadsheet of `columns` columns can hold. */
export function sheetsRowCap(columns: number): number {
  return Math.floor(SHEET_CELL_LIMIT / columns) - 1;
}

/** The columns we write — a sensible "key SEO snapshot" set. */
const HEADERS = [
  'URL',
  'Status',
  'Title',
  'Meta description',
  'H1',
  'Indexability',
  'Response time (ms)',
  'Depth',
  'Inlinks',
  'Outlinks',
  'Word count',
] as const;

function rowFromUrl(r: CrawlUrlRow): (string | number | null)[] {
  return [
    r.url,
    r.statusCode ?? null,
    r.title ?? '',
    r.metaDescription ?? '',
    r.h1 ?? '',
    r.indexability ?? '',
    r.responseTimeMs ?? null,
    r.depth ?? null,
    r.inlinks ?? null,
    r.outlinks ?? null,
    r.wordCount ?? null,
  ];
}

export interface SheetsExportOutput {
  /** Empty when there was nothing to export and no spreadsheet was created. */
  spreadsheetUrl: string;
  rowsWritten: number;
  /** Rows the dataset has; more than `rowsWritten` when `truncated`. */
  totalRows: number;
  truncated: boolean;
  dataset: GoogleExportDataset;
}

export interface SheetsExportOptions {
  /** Default `urls`: the `category` rows with the 11 key columns. */
  dataset?: GoogleExportDataset;
  deps?: Partial<GoogleDeps>;
  /** Tests lower these; the defaults are the Sheets limits. */
  limits?: Partial<{ batchRows: number; batchBytes: number; maxRows: number }>;
}

const defaultDeps: GoogleDeps = {
  fetch: apiFetch as unknown as typeof fetch,
  getToken: (refresh) => getAccessToken('sheets', undefined, refresh),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  random: Math.random,
  log: (level, message) => logger.log(level, 'sheets', message),
};

/** 1 -> A, 26 -> Z, 27 -> AA. */
function columnLetters(n: number): string {
  let out = '';
  for (let c = n; c > 0; c = Math.floor((c - 1) / 26)) {
    out = String.fromCharCode(65 + ((c - 1) % 26)) + out;
  }
  return out;
}

function rowsOf(
  db: ProjectDb,
  category: UrlCategory,
  dataset: GoogleExportDataset,
): { headers: string[]; rows: Iterable<RawCell[]> } {
  if (dataset !== 'urls') return datasetTable(db, dataset);
  return {
    headers: [...HEADERS],
    rows: (function* () {
      for (const row of db.iterateUrlsByCategory(category)) yield rowFromUrl(row);
    })(),
  };
}

export async function exportCategoryToSheets(
  db: ProjectDb,
  category: UrlCategory,
  title: string,
  opts: SheetsExportOptions = {},
): Promise<SheetsExportOutput> {
  const deps: GoogleDeps = { ...defaultDeps, ...opts.deps };
  const dataset = opts.dataset ?? 'urls';
  const { headers, rows } = rowsOf(db, category, dataset);
  const columns = headers.length;
  const lastCol = columnLetters(columns);
  const batchRows = opts.limits?.batchRows ?? BATCH_ROWS;
  const batchBytes = opts.limits?.batchBytes ?? BATCH_BYTES;
  const maxRows = opts.limits?.maxRows ?? sheetsRowCap(columns);

  const iter = rows[Symbol.iterator]();
  let carry: { row: RawCell[]; bytes: number } | null = null;
  let totalRows = 0;
  /** Up to one batch of data rows; the one that would break the byte limit waits in `carry`. */
  const nextBatch = (room: number): RawCell[][] => {
    const batch: RawCell[][] = [];
    let bytes = 0;
    while (batch.length < Math.min(batchRows, room)) {
      let item = carry;
      carry = null;
      if (!item) {
        const n = iter.next();
        if (n.done) break;
        item = { row: n.value, bytes: Buffer.byteLength(JSON.stringify(n.value)) + 1 };
      }
      if (batch.length > 0 && bytes + item.bytes > batchBytes) {
        carry = item;
        break;
      }
      batch.push(item.row);
      bytes += item.bytes;
    }
    totalRows += batch.length;
    return batch;
  };

  let batch = nextBatch(maxRows);
  if (batch.length === 0) {
    return { spreadsheetUrl: '', rowsWritten: 0, totalRows: 0, truncated: false, dataset };
  }

  // 1. Create the spreadsheet with a grid of exactly the exported columns.
  let gridRows = Math.min(batch.length + 1, 1000);
  const created = await googleRequest(deps, {
    op: 'Sheets create',
    method: 'POST',
    url: SHEETS_API,
    body: {
      properties: { title },
      sheets: [{ properties: { gridProperties: { rowCount: gridRows, columnCount: columns } } }],
    },
    timeoutMs: 30_000,
    retryNetwork: false,
  }).catch((err: unknown) => {
    // A rejected sign-in created nothing; any other failure may have landed with no id known to us.
    if (err instanceof GoogleAuthError) throw err;
    throw new Error(
      `${err instanceof Error ? err.message : 'Sheets create failed'}; create failed, check Drive for an empty spreadsheet`,
    );
  });
  const createJson = created.json as {
    spreadsheetId?: unknown;
    spreadsheetUrl?: unknown;
    sheets?: { properties?: { sheetId?: unknown } }[];
    error?: { message?: unknown };
  } | null;
  if (!created.ok || !createJson || typeof createJson.spreadsheetId !== 'string') {
    const err = (createJson?.error?.message as string | undefined) ?? `HTTP ${created.status}`;
    throw new Error(`Sheets create failed: ${err}`);
  }
  const spreadsheetId = createJson.spreadsheetId;
  const sheetId = createJson.sheets?.[0]?.properties?.sheetId ?? 0;
  const spreadsheetUrl =
    typeof createJson.spreadsheetUrl === 'string'
      ? createJson.spreadsheetUrl
      : `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

  const send = async (op: string, method: string, url: string, body: unknown) => {
    const res = await googleRequest(deps, { op, method, url, body });
    if (!res.ok) {
      const why = (res.json as { error?: { message?: unknown } } | null)?.error?.message;
      throw new Error(`${op} failed: HTTP ${res.status}${typeof why === 'string' ? ` (${why})` : ''}`);
    }
  };

  // 2. Write batch by batch; a later failure renames the spreadsheet.
  let written = 0;
  try {
    for (let n = 1; batch.length > 0; n++) {
      const first = n === 1;
      const values = first ? [headers, ...batch] : batch;
      const startRow = first ? 1 : written + 2;
      const endRow = startRow + values.length - 1;
      if (endRow > gridRows) {
        await send(`Sheets resize before batch ${n}`, 'POST', `${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId, gridProperties: { rowCount: endRow, columnCount: columns } },
                fields: 'gridProperties(rowCount,columnCount)',
              },
            },
          ],
        });
        gridRows = endRow;
      }
      await send(
        `Sheets write batch ${n}`,
        'PUT',
        `${SHEETS_API}/${spreadsheetId}/values/A${startRow}:${lastCol}${endRow}?valueInputOption=RAW`,
        { range: `A${startRow}:${lastCol}${endRow}`, majorDimension: 'ROWS', values },
      );
      written += batch.length;
      batch = nextBatch(maxRows - written);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'write failed';
    let renamed = true;
    try {
      await send('Sheets rename', 'POST', `${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
        requests: [
          {
            updateSpreadsheetProperties: {
              properties: { title: FAILED_TITLE },
              fields: 'title',
            },
          },
        ],
      });
    } catch {
      renamed = false;
    }
    throw new Error(
      `${reason}. ${written} row(s) were written to ${spreadsheetUrl}` +
        (renamed ? ` (renamed "${FAILED_TITLE}")` : ' (could not be renamed)') +
        ': delete it in Google Drive.',
    );
  }

  // 3. Count what the cap left out, without writing it.
  if (carry) totalRows++;
  while (!iter.next().done) totalRows++;
  const truncated = written < totalRows;
  logger.log(
    'info',
    'sheets',
    `exported ${written} of ${totalRows} row(s) to ${spreadsheetUrl}${truncated ? ' (stopped at the Sheets cell limit)' : ''}`,
  );
  return { spreadsheetUrl, rowsWritten: written, totalRows, truncated, dataset };
}
