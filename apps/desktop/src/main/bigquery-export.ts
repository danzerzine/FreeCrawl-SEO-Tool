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
 *   2. Create a fresh timestamped `<dataset>_<unix>` table: the fixed
 *      `urls` schema, or one STRING column per column of another dataset.
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
import { createSign } from 'node:crypto';
import type { ProjectDb } from '@freecrawl/db';
import type { CrawlUrlRow, UrlCategory } from '@freecrawl/shared-types';
import { resolveCredentials } from './credentials.js';
import { apiFetch } from './api-fetch.js';
import * as logger from './logger.js';
import { googleRequest, type GoogleDeps } from './google-retry.js';
import { datasetTable, type GoogleExportDataset } from './google-export-rows.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const BIGQUERY_API = 'https://bigquery.googleapis.com/bigquery/v2';
const SCOPE = 'https://www.googleapis.com/auth/bigquery';

/** Fixed dataset FreeCrawl writes into. The user can move tables out
 *  afterwards; using a stable name keeps the export idempotent. */
const DATASET_ID = 'freecrawl_seo';
const INSERT_CHUNK = 500;
const TOKEN_EXPIRY_SKEW_MS = 60_000;

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

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}
let tokenCache: CachedToken | null = null;

function base64url(buf: Buffer | string): string {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64url');
}

/** Parse and validate the stored service-account JSON. */
function parseServiceAccount(raw: string): ServiceAccount {
  if (!raw.trim()) {
    throw new Error(
      'No BigQuery service account — paste the JSON key in Settings → Integrations.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Service account JSON failed to parse: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Service account JSON is not an object.');
  }
  const sa = parsed as Partial<ServiceAccount>;
  if (typeof sa.client_email !== 'string' || !sa.client_email) {
    throw new Error('Service account JSON missing `client_email`.');
  }
  if (typeof sa.private_key !== 'string' || !sa.private_key.includes('PRIVATE KEY')) {
    throw new Error('Service account JSON missing `private_key`.');
  }
  return sa as ServiceAccount;
}

/** Mint a Google access token via the JWT-bearer grant. */
async function mintAccessToken(sa: ServiceAccount, forceRefresh = false): Promise<string> {
  if (!forceRefresh && tokenCache && tokenCache.expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
    return tokenCache.token;
  }
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_ENDPOINT,
    exp: now + 3600,
    iat: now,
  };
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(claim));
  const signingInput = `${header}.${body}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(sa.private_key, 'base64url');
  const jwt = `${signingInput}.${signature}`;

  const res = await apiFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
    error_description?: unknown;
  } | null;
  if (!res.ok || !json || typeof json.access_token !== 'string') {
    const msg =
      (json?.error_description as string | undefined) ??
      (json?.error as string | undefined) ??
      `token exchange failed (HTTP ${res.status})`;
    throw new Error(`BigQuery auth: ${msg}`);
  }
  const expiresIn =
    typeof json.expires_in === 'number' ? (json.expires_in as number) : 3600;
  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return tokenCache.token;
}

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

const defaultDeps = (getCreds: () => Record<string, string>): GoogleDeps => ({
  fetch: apiFetch as unknown as typeof fetch,
  getToken: (refresh) => mintAccessToken(parseServiceAccount(getCreds()['serviceAccountJson'] ?? ''), refresh),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  random: Math.random,
  log: (level, message) => logger.log(level, 'bigquery', message),
  authFix: 'Check the service-account key in Settings → Integrations (BigQuery): it may be deleted, disabled or pasted wrong.',
});

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
  tableId: string;
  tableRef: string;
  consoleUrl: string;
  rowsWritten: number;
  rowsRejected: number;
  firstRejectionError: string | null;
  dataset: GoogleExportDataset;
}

export interface BigQueryExportOptions {
  /** Default `urls`: the `category` rows with the 11 typed columns. */
  dataset?: GoogleExportDataset;
  deps?: Partial<GoogleDeps>;
  /** Project id and service-account JSON; default the stored credentials. */
  creds?: () => Record<string, string>;
}

type InsertRow = { insertId: string; json: Record<string, string | number | null> };

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
  const dataset = opts.dataset ?? 'urls';
  let schema: { fields: BqField[] };
  let rows: Iterable<InsertRow>;
  if (dataset === 'urls') {
    schema = URL_TABLE_SCHEMA;
    rows = (function* () {
      for (const r of db.iterateUrlsByCategory(category)) {
        yield { insertId: String(r.id), json: rowToJson(r) };
      }
    })();
  } else {
    ({ schema, rows } = datasetPlan(db, dataset));
  }

  // Nothing to export creates nothing (Sheets does the same), not an empty table.
  const iter = rows[Symbol.iterator]();
  const first = iter.next();
  if (first.done) {
    return { tableId: '', tableRef: '', consoleUrl: '', rowsWritten: 0, rowsRejected: 0, firstRejectionError: null, dataset };
  }
  const allRows: Iterable<InsertRow> = (function* () {
    yield first.value;
    for (let n = iter.next(); !n.done; n = iter.next()) yield n.value;
  })();

  await deps.getToken();
  await ensureDataset(deps, projectId, DATASET_ID);

  const tableId = `${snake(dataset)}_${Math.floor(deps.now() / 1000)}`;
  const tableRef = `${projectId}.${DATASET_ID}.${tableId}`;
  await createTable(deps, projectId, DATASET_ID, tableId, schema);
  deps.log('info', `created table ${tableRef}`);

  // Stream rows in chunks. `tabledata.insertAll` caps at 10 MB / request;
  // 500 rows × ~600 bytes ≈ 300 KB so we stay well under.
  let rowsWritten = 0;
  let rowsRejected = 0;
  let firstRejectionError: string | null = null;
  let chunkNo = 0;
  const insertChunk = async (chunk: InsertRow[]): Promise<void> => {
    chunkNo++;
    const url =
      `${BIGQUERY_API}/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(DATASET_ID)}` +
      `/tables/${encodeURIComponent(tableId)}/insertAll`;
    const where = `insertAll chunk ${chunkNo} failed`;
    const stopped = (why: string) =>
      new Error(
        `BigQuery ${where}: ${why}. ${rowsWritten} row(s) were written to ${tableRef}; the table stays, drop it in the console.`,
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

  const consoleUrl =
    `https://console.cloud.google.com/bigquery?` +
    `project=${encodeURIComponent(projectId)}&p=${encodeURIComponent(
      projectId,
    )}&d=${DATASET_ID}&t=${tableId}&page=table`;
  logger.log(
    'info',
    'bigquery',
    `exported ${rowsWritten} row(s) into ${tableRef}${rowsRejected ? `, ${rowsRejected} rejected` : ''}`,
  );
  return { tableId, tableRef, consoleUrl, rowsWritten, rowsRejected, firstRejectionError, dataset };
}
