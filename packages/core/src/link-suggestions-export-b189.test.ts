import { describe, expect, it } from 'vitest';
import { rankCandidates, type Candidate } from './link-suggestions.js';

describe('B189 rankCandidates', () => {
  const norm = new Float64Array([1, 1, 1, 1, 1, 0]);
  const better = (a: Candidate, b: Candidate): number => b.closeness - a.closeness || a.idx - b.idx;
  // Closeness in percent per source (target is index 0): 1:50, 2:90, 3:90, 4:5, 5:70 (zero norm).
  const scratch = new Float32Array([0, 0.5, 0.9, 0.9, 0.05, 0.7]);
  const touched = new Int32Array([1, 2, 3, 4, 5]);

  it('orders by closeness, then by the tie-break, and keeps perTarget', () => {
    expect(rankCandidates(touched, 5, scratch, norm, 0, 0, 2, better)).toEqual([
      { idx: 2, closeness: 90 },
      { idx: 3, closeness: 90 },
    ]);
  });
  it('drops sources under minCloseness and sources with a zero norm', () => {
    expect(rankCandidates(touched, 5, scratch, norm, 0, 20, 10, better).map((c) => c.idx)).toEqual([
      2, 3, 1,
    ]);
  });
  it('reads only the first `count` touched sources', () => {
    expect(rankCandidates(touched, 1, scratch, norm, 0, 0, 10, better)).toEqual([
      { idx: 1, closeness: 50 },
    ]);
  });
});
