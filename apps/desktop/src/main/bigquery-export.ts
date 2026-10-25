/**
 * Faz 7 — Google BigQuery export.
 *
 * Service-account auth (no OAuth keystone — BigQuery clients typically
 * authenticate as a *service*, not a user). The user pastes a Google
 * Cloud service-account JSON in Settings → Integrations; this module
 * signs a short-lived JWT with the embedded private key (RS256),
 * exchanges it at Google's token endpoint for an access token, then
 * uses that token to:
 *   1. Ensure the `freecrawl_seo` dataset exists in the user's project.
 *   2. Create a fresh timestamped `<dataset>_<unix>` table per chosen
 *      dataset (B156: one run may write several, `links` among them, all
 *      under one timestamp): the fixed `urls` schema, or one STRING column
 *      per column of another dataset.
 *   3. Stream the rows in via `tabledata.insertAll` in 500-row chunks,
 *      with `skipInvalidRows` and a stable `insertId` on every row so a
 *      retried chunk neither fails whole nor duplicates.
 *
 * A chunk that still fails after the retries stops the export; the
 * half-filled table stays (dropping it would be destructive in the user's
 * project) and the error names it.
 *
 * Per-process token cache — JWT round-trips are cheap but a single
 * export typically fits inside one token lifetime (1 hr).
 */
import type { ProjectDb } from '@freecrawl/db';
import type { CrawlUrlRow, GoogleExportTableResult, UrlCategory } from '@freecrawl/shared-types';
import { resolveCredentials } from './credentials.js';
import * as logger from './logger.js';
import { googleRequest, type GoogleDeps } from './google-retry.js';
import { defaultDeps } from './bigquery-auth.js';
import { datasetTable, type GoogleExportDataset } from './google-export-rows.js';

const BIGQUERY_API = 'https://bigquery.googleapis.com/bigquery/v2';

/** Fixed dataset FreeCrawl writes into. The user can move tables out
 *  afterwards; using a stable name keeps the export idempotent. */
const DATASET_ID = 'freecrawl_seo';
const INSERT_CHUNK = 500;

/** BigQuery schema for the exported URL rows — matches the Sheets
 *  export so both targets receive the same shape. */
const URL_TABLE_SCHEMA = {
  fields: [
    { name: 'url', type: 'STRING', mode: 'REQUIRED' },
    { name: 'status_code', type: 'INTEGER', mode: 'NULLABLE' },
    { name: 'title', type: 'STRING', mode: 'NULLABLE' },
    { name: 'meta_description', type: 'STRING', mode: 'NULLABLE' },
    { name: 'h1', type: 'STRING', mode: 'NULLABLE' },
    { name: 'indexability', type: 'STRING', mode: 'NULLABLE' },
    { name: 'response_time_ms', type: 'INTEGER', mode: 'NULLABLE' },
    { name: 'depth', type: 'INTEGER', mode: 'NULLABLE' },
    { name: 'inlinks', type: 'INTEGER', mode: 'NULLABLE' },
    { name: 'outlinks', type: 'INTEGER', mode: 'NULLABLE' },
    { name: 'word_count', type: 'INTEGER', mode: 'NULLABLE' },
  ],
};

function rowToJson(r: CrawlUrlRow): Record<string, string | number | null> {
  return {
    url: r.url,
    status_code: r.statusCode ?? null,
    title: r.title ?? null,
    meta_description: r.metaDescription ?? null,
    h1: r.h1 ?? null,
    indexability: r.indexability ?? null,
    response_time_ms: r.responseTimeMs ?? null,
    depth: r.depth ?? null,
    inlinks: r.inlinks ?? null,
    outlinks: r.outlinks ?? null,
    word_count: r.wordCount ?? null,
  };
}

/** Helper — turn a non-2xx BigQuery answer into a useful error. */
function bqError(res: { json: unknown }, fallback: string): Error {
  const msg = (res.json as { error?: { message?: unknown } } | null)?.error?.message;
  return new Error(`BigQuery: ${typeof msg === 'string' ? msg : fallback}`);
}

type BqField = { name: string; type: string; mode: string };

/** `Meta description` -> `meta_description`; a column name may not start with a digit. */
function snake(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[0-9]/.test(s) || s === '' ? `_${s}` : s;
}

/** Schema and rows of a non-`urls` dataset: every column STRING, names from the headers. */
function datasetPlan(db: ProjectDb, dataset: Exclude<GoogleExportDataset, 'urls'>) {
  const { headers, rows } = datasetTable(db, dataset);
  const seen = new Map<string, number>();
  const names = headers.map((h) => {
    const base = snake(h);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
  return {
    schema: { fields: names.map((name) => ({ name, type: 'STRING', mode: 'NULLABLE' })) },
    rows: (function* () {
      let i = 0;
      for (const cells of rows) {
        const json: Record<string, string | null> = {};
        names.forEach((name, c) => {
          const v = cells[c];
          json[name] = v === null || v === undefined ? null : String(v);
        });
        yield { insertId: `${dataset}:${i++}`, json };
      }
    })(),
  };
}

function schemaDiff(have: BqField[], want: BqField[]): string | null {
  const norm = (f: BqField) => `${f.name}:${f.type}:${f.mode ?? 'NULLABLE'}`;
  const a = have.map(norm).join(', ');
  const b = want.map(norm).join(', ');
  return a === b ? null : `existing [${a}], ours [${b}]`;
}

/** Create the dataset if it doesn't already exist (409 conflict OK). */
async function ensureDataset(deps: GoogleDeps, projectId: string, datasetId: string): Promise<void> {
  const res = await googleRequest(deps, {
    op: 'BigQuery dataset create',
    method: 'POST',
    url: `${BIGQUERY_API}/projects/${encodeURIComponent(projectId)}/datasets`,
    body: { datasetReference: { projectId, datasetId }, location: 'US' },
    timeoutMs: 30_000,
  });
  if (res.ok || res.status === 409) return;
  throw bqError(res, `dataset create failed (HTTP ${res.status})`);
}

async function createTable(
  deps: GoogleDeps,
  projectId: string,
  datasetId: string,
  tableId: string,
  schema: { fields: BqField[] },
): Promise<void> {
  const base = `${BIGQUERY_API}/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetId)}/tables`;
  const res = await googleRequest(deps, {
    op: 'BigQuery table create',
    method: 'POST',
    url: base,
    body: { tableReference: { projectId, datasetId, tableId }, schema },
    timeoutMs: 30_000,
  });
  if (res.ok) return;
  if (res.status !== 409) throw bqError(res, `table create failed (HTTP ${res.status})`);
  // The name is our own timestamp: a 409 means an earlier try of this call landed.
  const got = await googleRequest(deps, {
    op: 'BigQuery table get',
    method: 'GET',
    url: `${base}/${encodeURIComponent(tableId)}`,
    timeoutMs: 30_000,
  });
  const have = (got.json as { schema?: { fields?: BqField[] } } | null)?.schema?.fields ?? [];
  const diff = got.ok ? schemaDiff(have, schema.fields) : 'could not read it';
  if (diff) throw new Error(`BigQuery: table ${tableId} exists with another schema: ${diff}`);
}

interface InsertAllResponse {
  insertErrors?: { index?: number; errors?: { message?: string }[] }[];
}

export interface BigQueryExportOutput {
  /** The first table written; '' when no dataset had rows. */
  tableId: string;
  tableRef: string;
  consoleUrl: string;
  /** All tables together. */
  rowsWritten: number;
  rowsRejected: number;
  firstRejectionError: string | null;
  /** The first requested dataset. */
  dataset: GoogleExportDataset;
  /** B156: one entry per requested dataset, in request order (an empty one got no table). */
  tables: GoogleExportTableResult[];
}

export interface BigQueryExportOptions {
  /** Default `urls`: the `category` rows with the 11 typed columns. */
  dataset?: GoogleExportDataset;
  /** B156: several datasets, one table each under one timestamp; wins over `dataset`. */
  datasets?: GoogleExportDataset[];
  deps?: Partial<GoogleDeps>;
  /** Project id and service-account JSON; default the stored credentials. */
  creds?: () => Record<string, string>;
}

type InsertRow = { insertId: string; json: Record<string, string | number | null> };

function tablePlan(
  db: ProjectDb,
  category: UrlCategory,
  dataset: GoogleExportDataset,
): { schema: { fields: BqField[] }; rows: Iterable<InsertRow> } {
  if (dataset !== 'urls') return datasetPlan(db, dataset);
  return {
    schema: URL_TABLE_SCHEMA,
    rows: (function* () {
      for (const r of db.iterateUrlsByCategory(category)) {
        yield { insertId: String(r.id), json: rowToJson(r) };
      }
    })(),
  };
}

export async function exportCategoryToBigQuery(
  db: ProjectDb,
  category: UrlCategory,
  opts: BigQueryExportOptions = {},
): Promise<BigQueryExportOutput> {
  const getCreds = opts.creds ?? (() => resolveCredentials('bigquery'));
  const creds = getCreds();
  const projectId = (creds['projectId'] ?? '').trim();
  if (!projectId) {
    throw new Error(
      'No BigQuery project — paste the GCP project ID in Settings → Integrations.',
    );
  }
  const deps: GoogleDeps = { ...defaultDeps(getCreds), ...opts.deps };
  const datasets = [...new Set(opts.datasets?.length ? opts.datasets : [opts.dataset ?? 'urls'])];
  const stamp = Math.floor(deps.now() / 1000);
  const tables: GoogleExportTableResult[] = [];
  let ready = false;
  let firstRejectionError: string | null = null;

  for (const dataset of datasets) {
    const { schema, rows } = tablePlan(db, category, dataset);
    // Nothing to export creates nothing (Sheets does the same), not an empty table.
    const iter = rows[Symbol.iterator]();
    const first = iter.next();
    if (first.done) {
      tables.push({ dataset, tableRef: '', rowsWritten: 0, rowsRejected: 0, totalRows: 0, truncated: false });
      continue;
    }
    const allRows: Iterable<InsertRow> = (function* () {
      yield first.value;
      for (let n = iter.next(); !n.done; n = iter.next()) yield n.value;
    })();

    if (!ready) {
      await deps.getToken();
      await ensureDataset(deps, projectId, DATASET_ID);
      ready = true;
    }

    const tableId = `${snake(dataset)}_${stamp}`;
    const tableRef = `${projectId}.${DATASET_ID}.${tableId}`;
    const earlier = tables.filter((t) => t.tableRef).map((t) => `${t.tableRef} (${t.rowsWritten} row(s))`);
    const alsoWritten = earlier.length > 0 ? ` Written before it: ${earlier.join(', ')}.` : '';
    try {
      await createTable(deps, projectId, DATASET_ID, tableId, schema);
    } catch (err) {
      if (!alsoWritten) throw err;
      throw new Error(`${err instanceof Error ? err.message : String(err)}.${alsoWritten}`);
    }
    deps.log('info', `created table ${tableRef}`);

    // Stream rows in chunks. `tabledata.insertAll` caps at 10 MB / request;
    // 500 rows × ~600 bytes ≈ 300 KB so we stay well under.
    let rowsWritten = 0;
    let rowsRejected = 0;
    let chunkNo = 0;
    const insertChunk = async (chunk: InsertRow[]): Promise<void> => {
      chunkNo++;
      const url =
        `${BIGQUERY_API}/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(DATASET_ID)}` +
        `/tables/${encodeURIComponent(tableId)}/insertAll`;
      const where = `insertAll chunk ${chunkNo} failed`;
      const stopped = (why: string) =>
        new Error(
          `BigQuery ${where}: ${why}. ${rowsWritten} row(s) were written to ${tableRef}; the table stays, drop it in the console.${alsoWritten}`,
        );
      const res = await googleRequest(deps, {
        op: `BigQuery insertAll chunk ${chunkNo}`,
        method: 'POST',
        url,
        body: { skipInvalidRows: true, rows: chunk },
      }).catch((err: unknown) => {
        throw stopped(err instanceof Error ? err.message : 'request failed');
      });
      if (!res.ok) throw stopped(bqError(res, `HTTP ${res.status}`).message);
      const errs = (res.json as InsertAllResponse | null)?.insertErrors ?? [];
      const bad = new Set(errs.map((e) => e.index));
      if (bad.size > 0) {
        const first = errs[0]?.errors?.[0]?.message ?? 'unknown';
        firstRejectionError ??= first;
        deps.log('warn', `insertAll chunk ${chunkNo}: ${bad.size} row(s) rejected; first error: ${first}`);
      }
      rowsRejected += bad.size;
      rowsWritten += chunk.length - bad.size;
    };
    let buf: InsertRow[] = [];
    for (const row of allRows) {
      buf.push(row);
      if (buf.length >= INSERT_CHUNK) {
        await insertChunk(buf);
        buf = [];
      }
    }
    if (buf.length > 0) await insertChunk(buf);
    tables.push({
      dataset,
      tableRef,
      rowsWritten,
      rowsRejected,
      totalRows: rowsWritten + rowsRejected,
      truncated: false,
    });
    logger.log(
      'info',
      'bigquery',
      `exported ${rowsWritten} row(s) into ${tableRef}${rowsRejected ? `, ${rowsRejected} rejected` : ''}`,
    );
  }

  const firstTable = tables.find((t) => t.tableRef);
  const dataset = datasets[0]!;
  const rowsWritten = tables.reduce((sum, t) => sum + t.rowsWritten, 0);
  const rowsRejected = tables.reduce((sum, t) => sum + (t.rowsRejected ?? 0), 0);
  if (!firstTable?.tableRef) {
    return { tableId: '', tableRef: '', consoleUrl: '', rowsWritten: 0, rowsRejected: 0, firstRejectionError: null, dataset, tables };
  }
  const tableId = firstTable.tableRef.slice(`${projectId}.${DATASET_ID}.`.length);
  // One table opens that table; several open the dataset that holds them.
  const consoleUrl =
    `https://console.cloud.google.com/bigquery?` +
    `project=${encodeURIComponent(projectId)}&p=${encodeURIComponent(
      projectId,
    )}&d=${DATASET_ID}` +
    (tables.filter((t) => t.tableRef).length > 1 ? '&page=dataset' : `&t=${tableId}&page=table`);
  return { tableId, tableRef: firstTable.tableRef, consoleUrl, rowsWritten, rowsRejected, firstRejectionError, dataset, tables };
}
