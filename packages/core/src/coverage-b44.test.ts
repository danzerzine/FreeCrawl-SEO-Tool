import { describe, expect, it } from 'vitest';
import { coverageBytes, summarizeCoverage } from './coverage.js';

const fn = (...ranges: Array<[number, number, number]>) => ({
  functionName: 'f',
  isBlockCoverage: true,
  ranges: ranges.map(([startOffset, endOffset, count]) => ({ startOffset, endOffset, count })),
});

describe('B44 coverageBytes (V8 block coverage)', () => {
  it('a called script with a never-run block inside: the block is unused', () => {
    expect(coverageBytes(100, [fn([0, 100, 1], [20, 40, 0])])).toBe(80);
  });
  it('a never-run function with a run block nested inside: the nested block counts as used', () => {
    expect(coverageBytes(100, [fn([0, 100, 0], [10, 30, 2])])).toBe(20);
  });
  it('overlapping functions count a byte once (union)', () => {
    expect(coverageBytes(100, [fn([0, 60, 1]), fn([40, 100, 3])])).toBe(100);
  });
  it('ranges arrive in any order: parents are painted first', () => {
    expect(coverageBytes(100, [fn([20, 40, 0], [0, 100, 1])])).toBe(80);
  });
  it('nothing recorded is 0 used bytes; ranges past the end are cut', () => {
    expect(coverageBytes(100, [])).toBe(0);
    expect(coverageBytes(50, [fn([0, 100, 1])])).toBe(50);
    expect(coverageBytes(0, [fn([0, 10, 1])])).toBe(0);
  });
});

describe('B44 summarizeCoverage', () => {
  it('CSS: total is the text length, used is the sum of the used ranges', () => {
    const s = summarizeCoverage(
      [{ url: 'a.css', text: 'x'.repeat(1000), ranges: [{ start: 0, end: 300 }] }],
      [],
    );
    expect(s).toEqual({ cssBytes: 1000, cssUnusedBytes: 700, jsBytes: 0, jsUnusedBytes: 0 });
  });
  it('JS: entries without source are skipped, the rest are summed', () => {
    const s = summarizeCoverage(
      [],
      [
        { url: 'a.js', source: 'x'.repeat(100), functions: [fn([0, 100, 1], [20, 40, 0])] },
        { url: 'ext', functions: [fn([0, 500, 1])] },
      ],
    );
    expect(s).toEqual({ cssBytes: 0, cssUnusedBytes: 0, jsBytes: 100, jsUnusedBytes: 20 });
  });
  it('a page with neither stylesheets nor scripts is all zeros, not null', () => {
    expect(summarizeCoverage([], [])).toEqual({ cssBytes: 0, cssUnusedBytes: 0, jsBytes: 0, jsUnusedBytes: 0 });
  });
  it('overlapping CSS ranges of one sheet do not count twice and never exceed the text', () => {
    const s = summarizeCoverage(
      [{ url: 'a.css', text: 'x'.repeat(100), ranges: [{ start: 0, end: 80 }, { start: 50, end: 100 }, { start: 0, end: 500 }] }],
      [],
    );
    expect(s.cssUnusedBytes).toBe(0);
  });
});
