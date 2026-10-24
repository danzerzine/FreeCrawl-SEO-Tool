import type { DuplicateClusterRow } from '@freecrawl/shared-types';

export interface ClusterHeaderStats {
  /** Stored representative; null when none is recorded (old build, row deleted). */
  repUrl: string | null;
  /** Largest SimHash distance from the representative, in bits. */
  maxHamming: number | null;
  /**
   * Lowest MinHash text similarity to the representative, 0-100 (B103).
   * Null unless every member has one: a SimHash-only group has none.
   */
  minSimilarity: number | null;
}

/** Header numbers of one cluster, from its member rows. Nothing is guessed without a representative. */
export function clusterHeaderStats(members: readonly DuplicateClusterRow[]): ClusterHeaderStats {
  const repUrl = members[0]?.repUrl ?? null;
  if (repUrl === null) return { repUrl, maxHamming: null, minSimilarity: null };
  let maxHamming = 0;
  let minSimilarity: number | null = null;
  let allSimilar = true;
  for (const m of members) {
    if (m.hammingFromRep !== null && m.hammingFromRep > maxHamming) maxHamming = m.hammingFromRep;
    if (m.similarityToRep === null) allSimilar = false;
    else if (minSimilarity === null || m.similarityToRep < minSimilarity)
      minSimilarity = m.similarityToRep;
  }
  return { repUrl, maxHamming, minSimilarity: allSimilar ? minSimilarity : null };
}
