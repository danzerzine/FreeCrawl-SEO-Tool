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

export interface CoverageSummary {
  cssBytes: number;
  cssUnusedBytes: number;
  jsBytes: number;
  jsUnusedBytes: number;
}

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
