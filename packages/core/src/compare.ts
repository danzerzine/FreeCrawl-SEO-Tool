import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { freemem, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  asNoSpaceError,
  categoryWhereClause,
  checkFreeSpace,
  detectProjectFormat,
  EXPENSIVE_ISSUE_DEFINITIONS,
  LATER_CHECKS,
  packProject,
  ProjectDb,
  RENDER_CHECKS,
  UNPACKED_PER_PACKED,
  unpackProject,
  workFolder,
} from '@freecrawl/db';
import {
  checksWithDifferentThresholds,
  COMPARE_CATEGORIES,
  ISSUE_CATEGORIES,
} from '@freecrawl/shared-types';
import { escapeCsv } from './spreadsheet.js';
import type {
  CompareCategory,
  CompareDiffRow,
  CompareIssueChange,
  CompareMapped,
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
  /** URLs of A matched to a URL of B that differs only by scheme, `www.`, host case or a default port. */
  mapped: CompareMapped;
}

/** How many pairs `mapped.examples` lists. */
const MAPPED_EXAMPLES = 20;

/**
 * The URL without what a migration changes: scheme, a leading `www.`, host
 * case and a default port (`:80`, `:443`). A string that is no http(s) URL is
 * its own key.
 */
export function urlMapKey(url: string): string {
  const m = /^https?:\/\/([^/?#]*)([\s\S]*)$/i.exec(url);
  if (!m) return url;
  const host = m[1]!
    .toLowerCase()
    .replace(/:(80|443)$/, '')
    .replace(/^www\./, '');
  return `${host}${m[2] || '/'}`;
}

/**
 * Pairs the URLs only one side has: those that share a key, when exactly one
 * URL of each side has it. Returns A's URL -> B's URL.
 */
function pairUnmatched(
  mapA: ReadonlyMap<string, unknown>,
  mapB: ReadonlyMap<string, unknown>,
): Map<string, string> {
  const keyed = (own: ReadonlyMap<string, unknown>, other: ReadonlyMap<string, unknown>) => {
    const byKey = new Map<string, string | null>();
    for (const url of own.keys()) {
      if (other.has(url)) continue;
      const k = urlMapKey(url);
      byKey.set(k, byKey.has(k) ? null : url);
    }
    return byKey;
  };
  const inA = keyed(mapA, mapB);
  const inB = keyed(mapB, mapA);
  const pairs = new Map<string, string>();
  for (const [k, ua] of inA) {
    const ub = inB.get(k);
    if (ua && ub) pairs.set(ua, ub);
  }
  return pairs;
}

/** True when the comparison found any URL change or any changed check (B115: an empty one is not mailed). */
export function compareHasChanges(summary: CompareSummary): boolean {
  return (
    Object.values(summary.counts).some((n) => n > 0) || Object.keys(summary.issueChanges).length > 0
  );
}

/**
 * One plain line of what changed, for an alert email or a log: the kinds with
 * changes and their counts, then the number of checks that changed (B81).
 */
export function compareChangesText(summary: CompareSummary): string {
  const kinds = Object.entries(summary.counts)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${kind} ${n}`);
  const checks = Object.keys(summary.issueChanges).length;
  const head = `Changes since the previous crawl (${summary.totalA} → ${summary.totalB} URLs):`;
  if (kinds.length === 0 && checks === 0) return `${head} none.`;
  return `${head} ${[kinds.join(', '), checks > 0 ? `checks changed: ${checks}` : ''].filter(Boolean).join('; ')}.`;
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
  /** Bit i: the page has a verdict for `VERDICT_CHECKS[i]`; bit RENDERED_BIT: the browser rendered it (B162). */
  verdicts: number;
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

/**
 * Runs `fn` (a comparison of `a` and `b`) with both projects read through
 * SQLite's page cache, not the memory map: the checks read every page of both
 * files, and Windows counts every mapped page as the app's memory (4.2 GB vs
 * 1.8 GB on a 261k-page pair, same time). Like the bulk exports.
 */
export function compareWithoutMmap<T>(a: ProjectDb, b: ProjectDb, fn: () => T): Promise<T> {
  return a.withoutMmap(() => b.withoutMmap(async () => fn()));
}

export interface CompareProject {
  db: ProjectDb;
  /** Closes the project and deletes the temp copy, if any. */
  dispose: () => void;
  /** The stored checks were behind this build: rebuilt and written back into the file (B109). */
  rebuiltSaved: boolean;
}

/**
 * Open the other project of a comparison, for every consumer. An archive
 * `.seoproject` is unpacked to a temp working copy; a bare SQLite project is
 * read in place, read-only, unless it or its folder is read-only: then it is
 * read from a copy and nothing is created beside it (B120). When its stored (expensive) checks predate the
 * current definitions they are rebuilt once and kept in the file, so the
 * next comparison with it rebuilds nothing (B109): an archive is rebuilt in
 * its copy and repacked, a bare project in place through SQLite. A file that
 * cannot be written is left as it was and compared from a rebuilt copy.
 * Throws a user-facing message on a missing or unrecognised file. A copy
 * goes into `<workDir>/FreeCrawl-work` when a working folder is given (B31),
 * else the OS temp folder.
 */
export async function openCompareProject(
  path: string,
  workDir?: string,
  opts: { statfs?: Parameters<typeof checkFreeSpace>[2] } = {},
): Promise<CompareProject> {
  if (!existsSync(path)) throw new Error(`Project not found: ${path}`);
  const format = detectProjectFormat(path);
  if (format === 'unknown') {
    throw new Error(
      'This file is not a FreeCrawl project (unrecognised format). It may be corrupt or a different file type.',
    );
  }
  let dir: string | null = null;
  let copy = '';
  let db: ProjectDb | null = null;
  let rebuiltSaved = false;
  const dispose = (): void => {
    try {
      db?.close();
    } catch {
      /* already gone — the copy is removed regardless */
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
  const copyBase = (): string => {
    if (!workDir) return tmpdir();
    mkdirSync(workFolder(workDir), { recursive: true });
    return workFolder(workDir);
  };
  try {
    if (format === 'archive') {
      const needed = statSync(path).size * UNPACKED_PER_PACKED;
      // Before the copy folder exists: a full disk is reported, not half-filled.
      checkFreeSpace(copyBase(), needed, opts.statfs);
      dir = mkdtempSync(join(copyBase(), COMPARE_COPY_PREFIX));
      copy = join(dir, basename(path));
      try {
        await unpackProject(path, copy);
      } catch (err) {
        throw asNoSpaceError(err, copyBase(), needed);
      }
      db = new ProjectDb(copy);
    } else if (!writableInPlace(path)) {
      // Opened in place, SQLite would fail without a folder to put its log in, or leave
      // log files beside a read-only file that block writing later (B120).
      const log = `${path}-wal`;
      const needed = statSync(path).size + (existsSync(log) ? statSync(log).size : 0);
      checkFreeSpace(copyBase(), needed, opts.statfs);
      dir = mkdtempSync(join(copyBase(), COMPARE_COPY_PREFIX));
      copy = join(dir, basename(path));
      try {
        // The file and its log as they are, so rows not yet folded in come too.
        copyWritable(path, copy);
        if (existsSync(log)) copyWritable(log, `${copy}-wal`);
      } catch (err) {
        throw asNoSpaceError(err, copyBase(), needed);
      }
      db = new ProjectDb(copy);
      if (db.issueMaterialisationStale()) db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
    } else {
      db = new ProjectDb(path, { readOnly: true });
      if (db.issueMaterialisationStale()) {
        db.close();
        db = null;
        rebuiltSaved = await rebuildInPlace(path);
        if (rebuiltSaved) {
          db = new ProjectDb(path, { readOnly: true });
        } else {
          checkFreeSpace(copyBase(), statSync(path).size, opts.statfs);
          dir = mkdtempSync(join(copyBase(), COMPARE_COPY_PREFIX));
          copy = join(dir, basename(path));
          const source = new ProjectDb(path, { readOnly: true });
          try {
            // Through SQLite, not a file copy: rows still in the project's log are in the copy too.
            source.vacuumInto(copy);
          } finally {
            source.close();
          }
          db = new ProjectDb(copy);
          db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
        }
      } else {
        await warmOsCache(path);
      }
    }
    if (format === 'archive' && db.issueMaterialisationStale()) {
      db.recomputeUrlsIssues(EXPENSIVE_ISSUE_DEFINITIONS);
      // Closed so the copy is one complete file, then reopened for the compare.
      db.close();
      rebuiltSaved = await saveRebuilt(copy, path);
      db = new ProjectDb(copy);
    }
  } catch (err) {
    dispose();
    throw err;
  }
  return { db, dispose, rebuiltSaved };
}

/**
 * Whether a project file can be opened in place without a trace: the file and
 * its folder both allow writing (SQLite needs the folder for its log files).
 * The mode bits count too, so a read-only file reads as such for root.
 */
function writableInPlace(path: string): boolean {
  return [path, dirname(path)].every((p) => {
    try {
      accessSync(p, constants.W_OK);
      return (statSync(p).mode & 0o222) !== 0;
    } catch {
      return false;
    }
  });
}

/** Copies a file and makes the copy writable (a copy of a read-only file keeps its mode). */
function copyWritable(from: string, to: string): void {
  copyFileSync(from, to);
  chmodSync(to, 0o600);
}

/**
 * Reads the file front to back in 8 MB blocks so the comparison's page
 * reads come from the OS file cache. Read page by page from a cold cache, a
 * 5 GB project goes at about 50 MB/s even on an NVMe disk, in blocks at
 * several GB/s: 150 s against 67 s for a 261k-page pair (B109). Skipped
 * when the file would not fit in free memory. A copy just unpacked or
 * written is in the cache already.
 */
async function warmOsCache(path: string): Promise<void> {
  if ((await stat(path)).size > freemem()) return;
  const file = await open(path, 'r');
  try {
    const block = Buffer.allocUnsafe(8 << 20);
    let at = 0;
    for (let n; (n = (await file.read(block, 0, block.length, at)).bytesRead) > 0; ) at += n;
  } finally {
    await file.close();
  }
}

/**
 * Rebuilds the stale checks of a bare project in the file itself, through
 * SQLite in short transactions, so a crawl still writing it or a log left by a
 * crashed one is handled by SQLite's own locking and recovery. False when
 * the file cannot be written (a read-only file, a lock held too long).
 */
async function rebuildInPlace(path: string): Promise<boolean> {
  let db: ProjectDb | null = null;
  try {
    db = new ProjectDb(path);
    // In short steps, so a crawl writing the same file is not held up past its lock wait (B119).
    if (db.issueMaterialisationStale()) await db.recomputeUrlsIssuesYielding(EXPENSIVE_ISSUE_DEFINITIONS);
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* the rebuild committed or rolled back; nothing more to undo */
    }
  }
}

/**
 * Packs the rebuilt copy over the archive through a `.part` file and a
 * rename, so a failure leaves the file as it was. False when it cannot be
 * written (read-only folder, file locked): the compare goes on from the copy.
 */
async function saveRebuilt(copy: string, path: string): Promise<boolean> {
  try {
    await packProject(copy, path);
    return true;
  } catch {
    rmSync(`${path}.part`, { force: true });
    return false;
  }
}

const COMPARE_COPY_PREFIX = 'freecrawl-compare-';

/** Columns the newer kinds read. A missing one is selected as NULL and its kind is reported as not comparable. */
const KIND_COLUMNS = ['depth', 'schema_types', 'content_hash', 'content_source'] as const;

/**
 * B162: the checks that exist only after a successful render or audit, with the SQL
 * that says "this page has a verdict for it" (a NULL / -1 column is "not checked", not
 * "not flagged"). `cols` are the columns it reads; an older schema without one counts as a verdict.
 * The two JS-injected checks have no column of their own: their verdict is the rendered
 * signal below (kind render / heuristic / none).
 */
const VERDICT_CHECKS: readonly { key: UrlCategory; sql: string; cols: readonly string[] }[] = [
  { key: 'issues:h1-changed-by-js', sql: 'js_h1_changed IS NOT NULL', cols: ['js_h1_changed'] },
  { key: 'issues:canonical-changed-by-js', sql: 'js_canonical_changed IS NOT NULL', cols: ['js_canonical_changed'] },
  { key: 'issues:links-changed-by-js', sql: 'js_links_changed IS NOT NULL', cols: ['js_links_changed'] },
  { key: 'issues:text-changed-by-js', sql: 'js_text_changed IS NOT NULL', cols: ['js_text_changed'] },
  { key: 'issues:console-errors', sql: 'console_errors IS NOT NULL', cols: ['console_errors'] },
  { key: 'issues:failed-resources', sql: 'failed_resources IS NOT NULL', cols: ['failed_resources'] },
  { key: 'issues:low-contrast-text', sql: 'a11y_low_contrast IS NOT NULL', cols: ['a11y_low_contrast'] },
  { key: 'issues:focus-outline-suppressed', sql: 'a11y_focus_suppressed IS NOT NULL', cols: ['a11y_focus_suppressed'] },
  { key: 'issues:font-too-small', sql: 'a11y_small_font IS NOT NULL', cols: ['a11y_small_font'] },
  { key: 'issues:tap-targets-too-small', sql: 'a11y_tap_targets_small IS NOT NULL', cols: ['a11y_tap_targets_small'] },
  { key: 'issues:axe-critical-serious', sql: 'axe_serious IS NOT NULL', cols: ['axe_serious'] },
  {
    key: 'issues:axe-moderate-minor',
    sql: '(axe_violations IS NOT NULL AND axe_serious IS NOT NULL)',
    cols: ['axe_violations', 'axe_serious'],
  },
  { key: 'issues:axe-needs-review', sql: 'axe_incomplete IS NOT NULL', cols: ['axe_incomplete'] },
  { key: 'issues:content-wider-than-screen', sql: 'mobile_usable >= 0', cols: ['mobile_usable'] },
];
/** Bit of `MinimalRow.verdicts` for "the browser rendered this page". */
const RENDERED_BIT = VERDICT_CHECKS.length;
/** Checks whose verdict is the kind (render / heuristic / none), not a column. */
const KIND_CHECKS: ReadonlySet<UrlCategory> = new Set<UrlCategory>([
  'issues:noindex-js-injected',
  'issues:title-changed-by-js',
]);
/** Checks whose count needs the browser to have rendered the page (B162b). */
export const RENDER_DEPENDENT_CHECKS: ReadonlySet<UrlCategory> = new Set<UrlCategory>([
  ...VERDICT_CHECKS.map((c) => c.key),
  ...KIND_CHECKS,
]);
const RENDERED_SQL =
  '(js_h1_changed IS NOT NULL OR js_canonical_changed IS NOT NULL OR js_links_changed IS NOT NULL OR js_text_changed IS NOT NULL OR render_diff IS NOT NULL)';
const RENDERED_COLUMNS = [
  'js_h1_changed',
  'js_canonical_changed',
  'js_links_changed',
  'js_text_changed',
  'render_diff',
] as const;

/** One integer per page: the verdict bits (see `MinimalRow.verdicts`), as SQL. */
function verdictsSql(urlColumns: ReadonlySet<string>): string {
  const parts = VERDICT_CHECKS.map((c, i) =>
    c.cols.every((col) => urlColumns.has(col)) ? `((${c.sql}) << ${i})` : `(1 << ${i})`,
  );
  parts.push(
    RENDERED_COLUMNS.every((col) => urlColumns.has(col)) ? `(${RENDERED_SQL} << ${RENDERED_BIT})` : '0',
  );
  return parts.join(' | ');
}

function loadAll(db: ProjectDb, urlColumns: ReadonlySet<string>): Iterable<MinimalRow> {
  // Pull only the fields the diff needs — keeps memory bounded at 1M
  // URLs (~120 MB for the seven columns vs ~600 MB for the full table).
  // Streams rather than returning an array: the caller only ever funnels
  // these into a Map, and `.all()` meant the full row array and the Map
  // built from it were both live at peak — two copies per side, four in
  // total, all on the main thread.
  return db.iterateRows<MinimalRow>(
    `SELECT id, url, status_code, title, meta_description, h1, canonical,
              indexability, response_time_ms, ${KIND_COLUMNS.map((c) => (urlColumns.has(c) ? c : `NULL AS ${c}`)).join(', ')},
              ${verdictsSql(urlColumns)} AS verdicts
         FROM urls
        WHERE is_external = 0 AND content_kind = 'html'`,
  );
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
    verdicts: r.verdicts,
  };
}

const EMPTY_COUNTS = Object.fromEntries(COMPARE_CATEGORIES.map((k) => [k, 0])) as Record<
  CompareCategory,
  number
>;

const numberText = (n: number | null): string | null => (n !== null ? String(n) : null);

/** What `differs` reads besides the two rows. */
interface FieldCtx {
  /** Maps a URL the way the page's scheme / www move requires (identity for a page that did not move). */
  key: (url: string) => string;
  rtThreshold: number;
}

/**
 * The kinds read off one page present in both crawls: when the field changed,
 * and how a side's value shows in the row. `needs` names a column group a kind
 * is not comparable without (an older project lacks it).
 */
const FIELD_KINDS: readonly {
  category: CompareCategory;
  needs?: 'depth' | 'schema';
  differs: (a: MinimalRow, b: MinimalRow, ctx: FieldCtx) => boolean;
  show: (r: MinimalRow) => string | null;
}[] = [
  {
    category: 'status',
    differs: (a, b) => a.status_code !== b.status_code,
    show: (r) => numberText(r.status_code),
  },
  {
    category: 'title',
    differs: (a, b) => (a.title ?? '') !== (b.title ?? ''),
    show: (r) => r.title,
  },
  {
    category: 'meta',
    differs: (a, b) => (a.meta_description ?? '') !== (b.meta_description ?? ''),
    show: (r) => r.meta_description,
  },
  { category: 'h1', differs: (a, b) => (a.h1 ?? '') !== (b.h1 ?? ''), show: (r) => r.h1 },
  {
    category: 'canonical',
    differs: (a, b, { key }) => key(a.canonical ?? '') !== key(b.canonical ?? ''),
    show: (r) => r.canonical,
  },
  {
    category: 'indexability',
    differs: (a, b) => a.indexability !== b.indexability,
    show: (r) => r.indexability,
  },
  {
    // Response-time deltas are always noisy in the small: an absolute-ms floor applies.
    category: 'response_time',
    differs: (a, b, { rtThreshold }) =>
      Math.abs((a.response_time_ms ?? 0) - (b.response_time_ms ?? 0)) >= rtThreshold,
    show: (r) => (r.response_time_ms !== null ? `${r.response_time_ms} ms` : null),
  },
  {
    category: 'depth',
    needs: 'depth',
    differs: (a, b) => a.depth !== b.depth,
    show: (r) => numberText(r.depth),
  },
  {
    category: 'structured_data',
    needs: 'schema',
    differs: (a, b) => (a.schema_types ?? '') !== (b.schema_types ?? ''),
    show: (r) => r.schema_types,
  },
];

export function compareCrawls(
  a: ProjectDb,
  b: ProjectDb,
  options: CompareOptions = {},
): CompareSummary {
  const limit = options.perCategoryLimit ?? 5000;
  const rtThreshold = options.responseTimeThresholdMs ?? 500;

  // Consume each side straight into its Map — no intermediate array.
  const mapA = new Map<string, MinimalRow>();
  const colsA = a.tableColumns('urls');
  const colsB = b.tableColumns('urls');
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

  // URLs only one side has are paired across scheme / www changes first, so a
  // migration is not all removed plus all added.
  const pairs = pairUnmatched(mapA, mapB);
  const paired = new Set(pairs.values());
  const mapped: CompareMapped = { count: pairs.size, examples: [] };
  for (const [before, after] of pairs) {
    if (mapped.examples.length >= MAPPED_EXAMPLES) break;
    mapped.examples.push({ before, after });
  }

  // Added: in B but not in A.
  for (const [url, r] of mapB) {
    if (!mapA.has(url) && !paired.has(url)) {
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
    if (!mapB.has(url) && !pairs.has(url)) {
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
  // A later check the older crawl's build did not fill has zeros that mean
  // "not checked": listed as not comparable instead of "appeared".
  const filledA = a.checksFilled();
  const filledB = b.checksFilled();
  const unfilled = new Set(LATER_CHECKS.filter((k) => !filledA.has(k) || !filledB.has(k)));
  // A check counted against different limits in the two crawls would report
  // the setting change as a site change (B77).
  const rethresholded = new Set(
    checksWithDifferentThresholds(a.getSeoThresholds(), b.getSeoThresholds()),
  );
  const keys = ISSUE_CATEGORIES.filter(
    (k) =>
      !silenced.has(k) &&
      !unfilled.has(k) &&
      !rethresholded.has(k) &&
      categoryWhereClause(k) !== null,
  );
  const flagsA = flaggedChecks(a, keys);
  const flagsB = flaggedChecks(b, keys);
  const issueChanges: Record<string, CompareIssueChange> = {};
  let compared = 0;
  const hasLinkType = a.tableColumns('links').has('type') && b.tableColumns('links').has('type');
  const outlinksA = hasLinkType ? a.followedOutlinkReader() : null;
  const outlinksB = hasLinkType ? b.followedOutlinkReader() : null;
  // A kind is comparable only when both projects have all the columns it reads.
  const lacking = (...cols: string[]): string[] =>
    cols.filter((c) => !colsA.has(c) || !colsB.has(c));
  const notComparable: Record<string, CompareNotComparable> = {};
  const noDepth = lacking('depth').length > 0;
  const noSchema =
    lacking('schema_types').length > 0 || !a.schemaTypesStored() || !b.schemaTypesStored();
  const noContent = lacking('content_hash', 'content_source').length > 0;
  let contentSkipped = 0;
  const usable = keys.map((_, i) => !flagsA.failed.has(i) && !flagsB.failed.has(i));
  // B162: a page without a verdict for a check (never rendered / audited) is not "not flagged".
  // Kind of the verdict of the JS-injected checks: 2 rendered, 1 inline-script guess of a
  // text-mode crawl, 0 none (a JS-mode crawl that did not render this page).
  const jsModeA = RENDER_CHECKS.some((k) => filledA.has(k));
  const jsModeB = RENDER_CHECKS.some((k) => filledB.has(k));
  const kindOf = (verdicts: number, jsMode: boolean): number =>
    (verdicts >> RENDERED_BIT) & 1 ? 2 : jsMode ? 0 : 1;
  const verdictBit = keys.map((k) => VERDICT_CHECKS.findIndex((c) => c.key === k));
  const isKindCheck = keys.map((k) => KIND_CHECKS.has(k));
  const partlySkipped = keys.map(() => 0);
  const notComparableNeeds = { depth: noDepth, schema: noSchema };
  const fieldKinds = FIELD_KINDS.filter((k) => !k.needs || !notComparableNeeds[k.needs]);

  // Field-level changes — present in both, value differs.
  for (const [urlA, ra] of mapA) {
    const urlB = pairs.get(urlA) ?? urlA;
    const rb = mapB.get(urlB);
    if (!rb) continue;
    const url = urlB;
    // Only a page that moved across scheme / www reads its targets through the
    // same mapping; elsewhere such a move of a target is a real change.
    const key = pairs.has(urlA) ? urlMapKey : (u: string) => u;
    const ctx: FieldCtx = { key, rtThreshold };

    for (const kind of fieldKinds) {
      if (kind.differs(ra, rb, ctx)) {
        push({ url, category: kind.category, before: kind.show(ra), after: kind.show(rb) });
      }
    }
    compared++;
    // The targets are read one page at a time and dropped, so nothing per URL
    // is held in memory; the diff is what the row shows.
    const ja = outlinksA?.(ra.id) ?? '';
    const jb = outlinksB?.(rb.id) ?? '';
    if (ja !== jb) {
      const ta = ja ? ja.split('\n') : [];
      const tb = jb ? jb.split('\n') : [];
      const keysA = new Set(ta.map(key));
      const keysB = new Set(tb.map(key));
      const dropped = ta.filter((t) => !keysB.has(key(t))).sort();
      const added = tb.filter((t) => !keysA.has(key(t))).sort();
      if (dropped.length > 0 || added.length > 0) {
        push({
          url,
          category: 'outlinks',
          before: dropped.length > 0 ? dropped.join(' ') : null,
          after: added.length > 0 ? added.join(' ') : null,
        });
      }
    }
    const resolved: number[] = [];
    const appeared: number[] = [];
    for (let i = 0; i < keys.length; i++) {
      if (!usable[i]) continue;
      if (isKindCheck[i]) {
        const kA = kindOf(ra.verdicts, jsModeA);
        const kB = kindOf(rb.verdicts, jsModeB);
        if (kA !== kB || kA === 0) {
          if (kA !== 0 || kB !== 0) partlySkipped[i]!++;
          continue;
        }
      } else if (verdictBit[i]! >= 0) {
        const vA = (ra.verdicts >> verdictBit[i]!) & 1;
        const vB = (rb.verdicts >> verdictBit[i]!) & 1;
        if (!vA || !vB) {
          if (vA || vB) partlySkipped[i]!++;
          continue;
        }
      }
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
  if (noSchema) {
    notComparable.structured_data = {
      reason: lacking('schema_types').length
        ? `column schema_types missing in an older project`
        : 'a project from before structured data was stored (empty schema_types)',
      urls: compared,
    };
  }
  if (noContent) missing('content', lacking('content_hash', 'content_source'));
  if (!hasLinkType) missing('outlinks', ['links.type']);
  if (contentSkipped > 0) {
    notComparable.content = {
      reason: 'a page lacks a content hash, or the two crawls hashed a different content source',
      urls: contentSkipped,
    };
  }

  for (const k of unfilled) {
    if (silenced.has(k)) continue;
    notComparable[k] = {
      reason: 'not checked by the build that made one of the crawls',
      urls: compared,
    };
  }
  for (const k of rethresholded) {
    if (silenced.has(k) || unfilled.has(k)) continue;
    notComparable[k] = {
      reason: 'the two crawls counted this check with different thresholds',
      urls: compared,
    };
  }
  // Only for checks that ran (`usable`): a failed flag query keeps its own reason below.
  keys.forEach((k, i) => {
    if (partlySkipped[i]! > 0 && usable[i]) {
      notComparable[k] ??= {
        reason: `partly compared: ${partlySkipped[i]} pages had no verdict in one of the crawls (not rendered or not audited)`,
        urls: partlySkipped[i]!,
      };
    }
  });
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
    mapped,
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
