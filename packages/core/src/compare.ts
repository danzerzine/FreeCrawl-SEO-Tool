import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  categoryWhereClause,
  detectProjectFormat,
  EXPENSIVE_ISSUE_DEFINITIONS,
  ProjectDb,
  unpackProject,
} from '@freecrawl/db';
import { COMPARE_CATEGORIES, ISSUE_CATEGORIES } from '@freecrawl/shared-types';
import { escapeCsv } from './spreadsheet.js';
import type {
  CompareCategory,
  CompareDiffRow,
  CompareIssueChange,
  CompareNotComparable,
  UrlCategory,
} from '@freecrawl/shared-types';

/**
 * Cross-project diff engine. Compares two crawl databases by URL key
 * and surfaces high-signal SEO field changes:
 *
 *  - URLs added in B but missing from A (new pages)
 *  - URLs removed in A but missing from B (deleted / no-longer-found pages)
 *  - URLs present in both whose status code, title, meta, H1, canonical,
 *    indexability, or response time changed beyond a configurable
 *    threshold
 *
 * Designed for the "before / after deploy" workflow — we cap each
 * change category at `perCategoryLimit` (default 5000) so a 1M-URL
 * compare doesn't allocate a 20 MB JSON payload to ship to the
 * renderer. The summary counts are exact regardless of the cap.
 */
export interface CompareOptions {
  /**
   * Hard cap per change category for the returned `samples`. Counts
   * remain accurate; samples are truncated. Default 5000.
   */
  perCategoryLimit?: number;
  /**
   * Minimum response-time delta (ms) to surface as a change. Smaller
   * fluctuations are network noise. Default 500 ms.
   */
  responseTimeThresholdMs?: number;
  /** Called for every changed row, uncapped (the samples keep `perCategoryLimit`). */
  onRow?: (row: CompareDiffRow) => void;
}

export type { CompareCategory, CompareDiffRow };

export interface CompareSummary {
  /** Total URLs in each side. */
  totalA: number;
  totalB: number;
  /** Counts per category (exact, not capped). */
  counts: Record<CompareCategory, number>;
  /** Truncated sample rows per category (≤ perCategoryLimit). */
  samples: CompareDiffRow[];
  /** Per check, pages that appeared / resolved (pages in both crawls). */
  issueChanges: Record<string, CompareIssueChange>;
  /** Kinds the pair cannot be compared on, with the reason. */
  notComparable: Record<string, CompareNotComparable>;
}

interface MinimalRow {
  id: number;
  url: string;
  status_code: number | null;
  title: string | null;
  meta_description: string | null;
  h1: string | null;
  canonical: string | null;
  indexability: string;
  response_time_ms: number | null;
  depth: number | null;
  schema_types: string | null;
  content_hash: string | null;
  content_source: string | null;
}

/**
 * Prepared reader of one page's followed internal link targets (distinct).
 * Per `from_url_id` through idx_links_from, so no sort or scan of the table.
 */
function outlinkReader(db: ProjectDb): (urlId: number) => Set<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawDb = (db as any).db as {
    prepare: (sql: string) => { all: (...args: number[]) => unknown[] };
  };
  const stmt = rawDb.prepare(
    `SELECT DISTINCT to_url FROM links
      WHERE from_url_id = ? AND type = 'hyperlink' AND is_internal = 1
        AND (rel IS NULL OR rel NOT LIKE '%nofollow%')`,
  );
  return (urlId) => new Set((stmt.all(urlId) as { to_url: string }[]).map((r) => r.to_url));
}

/**
 * The checks each page is flagged by: one bitset per check over `urls.id`,
 * so a 261k-page pair holds a few MB, not a Map of per-page arrays. Membership
 * is the filter behind each check's list (`categoryWhereClause`), so cheap
 * checks count as well as the materialised ones. A check whose filter cannot
 * run on this project (an older schema) is listed in `failed`, not thrown.
 */
function flaggedChecks(
  db: ProjectDb,
  keys: readonly UrlCategory[],
): { has: (check: number, urlId: number) => boolean; failed: Map<number, string> } {
  const bits: (Uint8Array | null)[] = [];
  const failed = new Map<number, string>();
  const listed = db.urlIdsByCategories(keys);
  keys.forEach((key, i) => {
    const ids = listed.get(key);
    listed.delete(key);
    if (ids === undefined || ids instanceof Error) {
      failed.set(i, ids?.message ?? 'not listed');
      bits.push(null);
      return;
    }
    let max = 0;
    for (const id of ids) if (id > max) max = id;
    const set = new Uint8Array((max >> 3) + 1);
    for (const id of ids) set[id >> 3]! |= 1 << (id & 7);
    bits.push(set);
  });
  const has = (check: number, urlId: number): boolean =>
    ((bits[check]?.[urlId >> 3] ?? 0) & (1 << (urlId & 7))) !== 0;
  return { has, failed };
}

export interface CompareProject {
  db: ProjectDb;
  /** Closes the project and deletes the temp copy, if any. */
  dispose: () => void;
}

/**
 * Open the other project of a comparison, for every consumer. An archive
 * `.seoproject` is unpacked to a temp working copy; a bare SQLite project is
 * read in place, read-only, and copied only when its stored (expensive)
 * checks predate the current definitions: they are rebuilt in the copy, so
 * the file the user picked is never written. Throws a user-facing message on
 * a missing or unrecognised file.
 */
export async function openCompareProject(path: string): Promise<CompareProject> {
  if (!existsSync(path)) throw new Error(`Project not found: ${path}`);
  const format = detectProjectFormat(path);
  if (format === 'unknown') {
    throw new Error(
      'This file is not a FreeCrawl project (unrecognised format). It may be corrupt or a different file type.',
    );
  }
  let dir: string | null = null;
  let db: ProjectDb | null = null;
  const dispose = (): void => {
    try {
      db?.close();
    } catch {
      /* already gone — the copy is removed regardless */
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
  try {
    if (format === 'archive') {
      dir = mkdtempSync(join(tmpdir(), COMPARE_COPY_PREFIX));
      const copy = join(dir, basename(path));
      await unpackProject(path, copy);
      db = new ProjectDb(copy);
    } else {
      db = new ProjectDb(path, { readOnly: true });
      if (db.issueMaterialisationStale()) {
        db.close();
        dir = mkdtempSync(join(tmpdir(), COMPARE_COPY_PREFIX));
        const copy = join(dir, basename(path));
        copyFileSync(path, copy);
        db = new ProjectDb(copy);
      }
    }
    if (dir && db.issueMaterialisationStale()) db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
  } catch (err) {
    dispose();
    throw err;
  }
  return { db, dispose };
}

const COMPARE_COPY_PREFIX = 'freecrawl-compare-';

/** Column names of a table; an older project lacks the ones added later. */
function columnsOf(db: ProjectDb, table: string): Set<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawDb = (db as any).db as { prepare: (sql: string) => { all: () => unknown[] } };
  return new Set(
    (rawDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
  );
}

/** Columns the newer kinds read. A missing one is selected as NULL and its kind is reported as not comparable. */
const KIND_COLUMNS = ['depth', 'schema_types', 'content_hash', 'content_source'] as const;

function loadAll(db: ProjectDb, urlColumns: ReadonlySet<string>): Iterable<MinimalRow> {
  // Pull only the fields the diff needs — keeps memory bounded at 1M
  // URLs (~120 MB for the seven columns vs ~600 MB for the full table).
  // Reaches into the underlying DatabaseSync via ProjectDb.exec for the
  // raw SELECT — no public iterator covers exactly this projection and
  // the diff is a one-shot operation, so we keep the helper here.
  //
  // Streams rather than returning an array: the caller only ever funnels
  // these into a Map, and `.all()` meant the full row array and the Map
  // built from it were both live at peak — two copies per side, four in
  // total, all on the main thread.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawDb = (db as any).db as {
    prepare: (sql: string) => { iterate: () => Iterable<unknown> };
  };
  return rawDb
    .prepare(
      `SELECT id, url, status_code, title, meta_description, h1, canonical,
              indexability, response_time_ms, ${KIND_COLUMNS.map((c) => (urlColumns.has(c) ? c : `NULL AS ${c}`)).join(', ')}
         FROM urls
        WHERE is_external = 0 AND content_kind = 'html'`,
    )
    .iterate() as Iterable<MinimalRow>;
}

/**
 * A copy of the row as one object literal: every row shares one shape, which
 * holds 261k rows per side in less heap than the rows the driver returns.
 */
function compactRow(r: MinimalRow): MinimalRow {
  return {
    id: r.id,
    url: r.url,
    status_code: r.status_code,
    title: r.title,
    meta_description: r.meta_description,
    h1: r.h1,
    canonical: r.canonical,
    indexability: r.indexability,
    response_time_ms: r.response_time_ms,
    depth: r.depth,
    schema_types: r.schema_types,
    content_hash: r.content_hash,
    content_source: r.content_source,
  };
}

const EMPTY_COUNTS: Record<CompareCategory, number> = {
  added: 0,
  removed: 0,
  status: 0,
  title: 0,
  meta: 0,
  h1: 0,
  canonical: 0,
  indexability: 0,
  response_time: 0,
  depth: 0,
  content: 0,
  structured_data: 0,
  outlinks: 0,
  issues: 0,
};

export function compareCrawls(
  a: ProjectDb,
  b: ProjectDb,
  options: CompareOptions = {},
): CompareSummary {
  const limit = options.perCategoryLimit ?? 5000;
  const rtThreshold = options.responseTimeThresholdMs ?? 500;

  // Consume each side straight into its Map — no intermediate array.
  const mapA = new Map<string, MinimalRow>();
  const colsA = columnsOf(a, 'urls');
  const colsB = columnsOf(b, 'urls');
  for (const r of loadAll(a, colsA)) mapA.set(r.url, compactRow(r));
  const mapB = new Map<string, MinimalRow>();
  for (const r of loadAll(b, colsB)) mapB.set(r.url, compactRow(r));

  const counts: Record<CompareCategory, number> = { ...EMPTY_COUNTS };
  const samples: CompareDiffRow[] = [];
  // Per-category sample tally so the cap check is O(1). The previous
  // `samples.filter(...).length` scanned the whole samples array on every
  // push — O(n²) that hung for minutes comparing two large divergent crawls.
  const sampleCounts: Record<CompareCategory, number> = { ...EMPTY_COUNTS };

  const push = (row: CompareDiffRow): void => {
    counts[row.category]++;
    options.onRow?.(row);
    if (sampleCounts[row.category] < limit) {
      samples.push(row);
      sampleCounts[row.category]++;
    }
  };

  // Added: in B but not in A.
  for (const [url, r] of mapB) {
    if (!mapA.has(url)) {
      push({
        url,
        category: 'added',
        before: null,
        after: r.status_code !== null ? String(r.status_code) : null,
      });
    }
  }

  // Removed: in A but not in B. Scan the other direction so we don't
  // double-pass the larger of the two maps.
  for (const [url, r] of mapA) {
    if (!mapB.has(url)) {
      push({
        url,
        category: 'removed',
        before: r.status_code !== null ? String(r.status_code) : null,
        after: null,
      });
    }
  }

  // Checks silenced in either project are left out of the comparison.
  const silenced = new Set([...a.getDisabledIssues(), ...b.getDisabledIssues()]);
  const keys = ISSUE_CATEGORIES.filter((k) => !silenced.has(k) && categoryWhereClause(k) !== null);
  const flagsA = flaggedChecks(a, keys);
  const flagsB = flaggedChecks(b, keys);
  const issueChanges: Record<string, CompareIssueChange> = {};
  let compared = 0;
  const hasLinkType = columnsOf(a, 'links').has('type') && columnsOf(b, 'links').has('type');
  const outlinksA = hasLinkType ? outlinkReader(a) : null;
  const outlinksB = hasLinkType ? outlinkReader(b) : null;
  // A kind is comparable only when both projects have all the columns it reads.
  const lacking = (...cols: string[]): string[] =>
    cols.filter((c) => !colsA.has(c) || !colsB.has(c));
  const notComparable: Record<string, CompareNotComparable> = {};
  const noDepth = lacking('depth').length > 0;
  const noSchema = lacking('schema_types').length > 0;
  const noContent = lacking('content_hash', 'content_source').length > 0;
  let contentSkipped = 0;
  const usable = keys.map((_, i) => !flagsA.failed.has(i) && !flagsB.failed.has(i));

  // Field-level changes — present in both, value differs.
  for (const [url, ra] of mapA) {
    const rb = mapB.get(url);
    if (!rb) continue;

    if (ra.status_code !== rb.status_code) {
      push({
        url,
        category: 'status',
        before: ra.status_code !== null ? String(ra.status_code) : null,
        after: rb.status_code !== null ? String(rb.status_code) : null,
      });
    }
    if ((ra.title ?? '') !== (rb.title ?? '')) {
      push({
        url,
        category: 'title',
        before: ra.title,
        after: rb.title,
      });
    }
    if ((ra.meta_description ?? '') !== (rb.meta_description ?? '')) {
      push({
        url,
        category: 'meta',
        before: ra.meta_description,
        after: rb.meta_description,
      });
    }
    if ((ra.h1 ?? '') !== (rb.h1 ?? '')) {
      push({
        url,
        category: 'h1',
        before: ra.h1,
        after: rb.h1,
      });
    }
    if ((ra.canonical ?? '') !== (rb.canonical ?? '')) {
      push({
        url,
        category: 'canonical',
        before: ra.canonical,
        after: rb.canonical,
      });
    }
    if (ra.indexability !== rb.indexability) {
      push({
        url,
        category: 'indexability',
        before: ra.indexability,
        after: rb.indexability,
      });
    }
    // Response-time deltas are always noisy in the small. Apply a
    // configurable absolute-ms floor before flagging.
    const rtA = ra.response_time_ms ?? 0;
    const rtB = rb.response_time_ms ?? 0;
    if (Math.abs(rtA - rtB) >= rtThreshold) {
      push({
        url,
        category: 'response_time',
        before: ra.response_time_ms !== null ? `${ra.response_time_ms} ms` : null,
        after: rb.response_time_ms !== null ? `${rb.response_time_ms} ms` : null,
      });
    }
    if (!noDepth && ra.depth !== rb.depth) {
      push({
        url,
        category: 'depth',
        before: ra.depth !== null ? String(ra.depth) : null,
        after: rb.depth !== null ? String(rb.depth) : null,
      });
    }
    if (!noSchema && (ra.schema_types ?? '') !== (rb.schema_types ?? '')) {
      push({
        url,
        category: 'structured_data',
        before: ra.schema_types,
        after: rb.schema_types,
      });
    }
    compared++;
    // The sets are read one page at a time and dropped, so nothing per URL
    // is held in memory; the diff is what the row shows.
    const ta = outlinksA?.(ra.id) ?? new Set<string>();
    const tb = outlinksB?.(rb.id) ?? new Set<string>();
    const dropped = [...ta].filter((t) => !tb.has(t)).sort();
    const added = [...tb].filter((t) => !ta.has(t)).sort();
    if (dropped.length > 0 || added.length > 0) {
      push({
        url,
        category: 'outlinks',
        before: dropped.length > 0 ? dropped.join(' ') : null,
        after: added.length > 0 ? added.join(' ') : null,
      });
    }
    const resolved: number[] = [];
    const appeared: number[] = [];
    for (let i = 0; i < keys.length; i++) {
      if (!usable[i]) continue;
      const inA = flagsA.has(i, ra.id);
      if (inA !== flagsB.has(i, rb.id)) (inA ? resolved : appeared).push(i);
    }
    if (resolved.length > 0 || appeared.length > 0) {
      for (const i of resolved)
        (issueChanges[keys[i]!] ??= { appeared: 0, resolved: 0 }).resolved++;
      for (const i of appeared)
        (issueChanges[keys[i]!] ??= { appeared: 0, resolved: 0 }).appeared++;
      push({
        url,
        category: 'issues',
        before: resolved.length > 0 ? resolved.map((i) => keys[i]).join(' ') : null,
        after: appeared.length > 0 ? appeared.map((i) => keys[i]).join(' ') : null,
      });
    }
    // A hash is comparable only when both sides have one, from the same
    // content source (main text vs whole body hash differently).
    if (noContent) {
      // reported once below
    } else if (
      ra.content_hash === null ||
      rb.content_hash === null ||
      ra.content_source === null ||
      ra.content_source !== rb.content_source
    ) {
      contentSkipped++;
    } else if (ra.content_hash !== rb.content_hash) {
      push({
        url,
        category: 'content',
        before: ra.content_hash.slice(0, 12),
        after: rb.content_hash.slice(0, 12),
      });
    }
  }
  const missing = (kind: string, cols: string[]): void => {
    notComparable[kind] = {
      reason: `column ${cols.join(', ')} missing in an older project`,
      urls: compared,
    };
  };
  if (noDepth) missing('depth', lacking('depth'));
  if (noSchema) missing('structured_data', lacking('schema_types'));
  if (noContent) missing('content', lacking('content_hash', 'content_source'));
  if (!hasLinkType) missing('outlinks', ['links.type']);
  if (contentSkipped > 0) {
    notComparable.content = {
      reason: 'a page lacks a content hash, or the two crawls hashed a different content source',
      urls: contentSkipped,
    };
  }

  for (const failed of [flagsA.failed, flagsB.failed]) {
    for (const [i, reason] of failed) {
      notComparable[keys[i]!] ??= { reason, urls: compared };
    }
  }

  return {
    // `urls.url` is `NOT NULL UNIQUE`, so one Map entry per row — these
    // are the same totals the intermediate arrays used to report.
    totalA: mapA.size,
    totalB: mapB.size,
    counts,
    samples,
    issueChanges,
    notComparable,
  };
}

/**
 * `compareCrawls` that also writes `compare-summary.json` and one
 * `compare-<kind>.csv` (url, before, after) per kind into `dir`, every row,
 * streamed in 64K blocks as the rows are found.
 */
export function compareToFiles(
  a: ProjectDb,
  b: ProjectDb,
  dir: string,
  options: CompareOptions = {},
): CompareSummary {
  mkdirSync(dir, { recursive: true });
  const files = new Map<CompareCategory, { fd: number; buf: string }>();
  for (const kind of COMPARE_CATEGORIES) {
    const fd = openSync(join(dir, `compare-${kind}.csv`), 'w');
    files.set(kind, { fd, buf: 'url,before,after\n' });
  }
  const flush = (f: { fd: number; buf: string }): void => {
    writeSync(f.fd, f.buf);
    f.buf = '';
  };
  try {
    const summary = compareCrawls(a, b, {
      ...options,
      onRow: (row) => {
        const f = files.get(row.category)!;
        f.buf += `${[row.url, row.before, row.after].map((v) => escapeCsv(v)).join(',')}\n`;
        if (f.buf.length >= 65536) flush(f);
        options.onRow?.(row);
      },
    });
    writeFileSync(join(dir, 'compare-summary.json'), JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    for (const f of files.values()) {
      try {
        flush(f);
      } finally {
        closeSync(f.fd);
      }
    }
  }
}
