import { describe, expect, it } from 'vitest';
import type { DuplicateClusterRow } from '@freecrawl/shared-types';
import { clusterHeaderStats } from './duplicateHeader.js';

const row = (p: Partial<DuplicateClusterRow>): DuplicateClusterRow =>
  ({
    repUrl: 'https://a.test/',
    hammingFromRep: null,
    similarityToRep: null,
    ...p,
  }) as DuplicateClusterRow;

describe('Duplicate group header (B103)', () => {
  it('shows the lowest text similarity to the representative for a text-similarity group', () => {
    const s = clusterHeaderStats([
      row({ similarityToRep: 100, hammingFromRep: 0 }),
      row({ similarityToRep: 93, hammingFromRep: 9 }),
      row({ similarityToRep: 97, hammingFromRep: 4 }),
    ]);
    expect(s.minSimilarity).toBe(93);
    expect(s.maxHamming).toBe(9);
  });

  it('has no similarity for a SimHash-only group, which keeps the bit distance', () => {
    const s = clusterHeaderStats([
      row({ hammingFromRep: 0 }),
      row({ hammingFromRep: 2 }),
    ]);
    expect(s.minSimilarity).toBeNull();
    expect(s.maxHamming).toBe(2);
  });

  it('has no similarity when one member lacks it (nothing is guessed)', () => {
    const s = clusterHeaderStats([
      row({ similarityToRep: 100, hammingFromRep: 0 }),
      row({ similarityToRep: null, hammingFromRep: 1 }),
    ]);
    expect(s.minSimilarity).toBeNull();
  });

  it('has neither without a stored representative', () => {
    const s = clusterHeaderStats([row({ repUrl: null }), row({ repUrl: null })]);
    expect(s).toEqual({ repUrl: null, maxHamming: null, minSimilarity: null });
  });
});
