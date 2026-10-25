/**
 * CSS and JavaScript coverage of a rendered page (B44): how many bytes the page
 * loaded and how many of them nothing used. Sizes are UTF-16 code units of the
 * stylesheet or script text, the unit the browser reports offsets in; they are
 * not transfer sizes.
 */

export interface CoverageRange {
  startOffset: number;
  endOffset: number;
  count: number;
}

export interface CoverageFunction {
  functionName?: string;
  isBlockCoverage?: boolean;
  ranges: CoverageRange[];
}

export interface CssCoverageEntry {
  url: string;
  text?: string;
  ranges: Array<{ start: number; end: number }>;
}

export interface JsCoverageEntry {
  url: string;
  source?: string;
  functions: CoverageFunction[];
}

/** One stylesheet or script file of a page and how much of it the page left unused (B44b). */
export interface CoverageFile {
  url: string;
  kind: 'css' | 'js';
  bytes: number;
  unusedBytes: number;
}

export interface CoverageSummary {
  cssBytes: number;
  cssUnusedBytes: number;
  jsBytes: number;
  jsUnusedBytes: number;
  /** The page's external files, most unused first (B44b); absent when it loaded none. */
  files?: CoverageFile[];
}

/** Files kept per page: the most unused ones. */
export const COVERAGE_FILES_CAP = 100;

/**
 * Used bytes of one script from V8 block coverage. A nested range overrides
 * its parent, so the ranges of all functions are painted parents first
 * (start ascending, end descending): a never-called function with a block that
 * ran stays used for that block only, and a called function with a skipped
 * branch loses the branch.
 */
export function coverageBytes(
  sourceLength: number,
  functions: readonly CoverageFunction[],
): number {
  if (sourceLength <= 0) return 0;
  const ranges: CoverageRange[] = [];
  for (const f of functions) for (const r of f.ranges) ranges.push(r);
  ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const used = new Uint8Array(sourceLength);
  for (const r of ranges) {
    const from = Math.max(0, r.startOffset);
    const to = Math.min(sourceLength, r.endOffset);
    if (to > from) used.fill(r.count > 0 ? 1 : 0, from, to);
  }
  let n = 0;
  for (let i = 0; i < used.length; i++) n += used[i]!;
  return n;
}

function cssUsedBytes(
  textLength: number,
  ranges: ReadonlyArray<{ start: number; end: number }>,
): number {
  const used = new Uint8Array(textLength);
  for (const r of ranges) {
    const from = Math.max(0, r.start);
    const to = Math.min(textLength, r.end);
    if (to > from) used.fill(1, from, to);
  }
  let n = 0;
  for (let i = 0; i < used.length; i++) n += used[i]!;
  return n;
}

/**
 * The page's stylesheet and script files (B44b). Code inline in the page
 * (reported under the document's own URL, or with no URL) counts in the page
 * totals only: it is no file of its own. A file reported twice is one entry
 * with both parts added up, as the totals count it. At most
 * {@link COVERAGE_FILES_CAP} entries, the most unused first.
 */
export function coverageFiles(
  css: readonly CssCoverageEntry[],
  js: readonly JsCoverageEntry[],
  documentUrls: readonly string[],
): CoverageFile[] {
  const skip = new Set(documentUrls);
  const byKey = new Map<string, CoverageFile>();
  const add = (url: string, kind: 'css' | 'js', bytes: number, unusedBytes: number): void => {
    if (!url || skip.has(url) || url.startsWith('data:')) return;
    const key = `${kind} ${url}`;
    const f = byKey.get(key);
    if (f) {
      f.bytes += bytes;
      f.unusedBytes += unusedBytes;
    } else {
      byKey.set(key, { url, kind, bytes, unusedBytes });
    }
  };
  for (const e of css) {
    if (typeof e.text !== 'string') continue;
    add(e.url, 'css', e.text.length, e.text.length - cssUsedBytes(e.text.length, e.ranges));
  }
  for (const e of js) {
    if (typeof e.source !== 'string') continue;
    add(e.url, 'js', e.source.length, e.source.length - coverageBytes(e.source.length, e.functions));
  }
  return [...byKey.values()]
    .sort((a, b) => b.unusedBytes - a.unusedBytes || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
    .slice(0, COVERAGE_FILES_CAP);
}

/** The four stored numbers. A page with no stylesheet or script gives zeros (measured, nothing there). */
export function summarizeCoverage(
  css: readonly CssCoverageEntry[],
  js: readonly JsCoverageEntry[],
): CoverageSummary {
  const out: CoverageSummary = { cssBytes: 0, cssUnusedBytes: 0, jsBytes: 0, jsUnusedBytes: 0 };
  for (const e of css) {
    if (typeof e.text !== 'string') continue;
    out.cssBytes += e.text.length;
    out.cssUnusedBytes += e.text.length - cssUsedBytes(e.text.length, e.ranges);
  }
  for (const e of js) {
    if (typeof e.source !== 'string') continue;
    out.jsBytes += e.source.length;
    out.jsUnusedBytes += e.source.length - coverageBytes(e.source.length, e.functions);
  }
  return out;
}
