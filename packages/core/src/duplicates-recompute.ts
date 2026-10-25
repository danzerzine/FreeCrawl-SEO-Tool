import type { ProjectDb } from '@freecrawl/db';
import type { CrawlConfig } from '@freecrawl/shared-types';

export type DuplicateRecomputeResult = ReturnType<ProjectDb['recomputeDuplicateClusters']>;

/**
 * Rebuilds the near-duplicate groups of an existing project from the fingerprints it stores, with the
 * given duplicate settings, and stores each group's representative (B104). A project crawled by a build
 * before representatives were stored lists its groups without one until this runs. Null when the
 * settings turn clustering off (nothing is touched then).
 */
export function recomputeDuplicateGroups(
  db: ProjectDb,
  config: Pick<CrawlConfig, 'nearDuplicateHammingThreshold' | 'nearDuplicateSimilarity' | 'duplicatesOnlyIndexable'>,
): DuplicateRecomputeResult | null {
  const threshold = config.nearDuplicateHammingThreshold;
  const similarity = config.nearDuplicateSimilarity ?? 0;
  if ((!threshold || threshold <= 0) && similarity <= 0) return null;
  return db.recomputeDuplicateClusters(threshold > 0 ? threshold : -1, config.duplicatesOnlyIndexable, similarity);
}
