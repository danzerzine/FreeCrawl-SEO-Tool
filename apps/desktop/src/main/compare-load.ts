import { compareCrawls, compareWithoutMmap, openCompareProject } from '@freecrawl/core';
import type { ProjectDb } from '@freecrawl/db';
import {
  COMPARE_CATEGORIES,
  type CompareCategory,
  type CompareLoadResult,
} from '@freecrawl/shared-types';

/** What the dialog gets when the user cancels the file picker. */
export function cancelledCompareResult(): CompareLoadResult {
  const counts = Object.fromEntries(COMPARE_CATEGORIES.map((c) => [c, 0])) as Record<
    CompareCategory,
    number
  >;
  return {
    filePath: '',
    totalA: 0,
    totalB: 0,
    counts,
    samples: [],
    issueChanges: {},
    notComparable: {},
    mapped: { count: 0, examples: [] },
  };
}

/**
 * Compare the open project (the newer crawl, "after") with a picked file
 * ("before"). The picked project is opened by `openCompareProject`: an
 * archive through a temp copy that is deleted after; written only to save
 * stored checks it had to rebuild (B109). `workDir`: the chosen working
 * folder for that copy (B31).
 */
export async function compareWithOpenProject(
  open: ProjectDb,
  filePath: string,
  workDir?: string,
): Promise<CompareLoadResult> {
  const picked = await openCompareProject(filePath, workDir);
  try {
    const s = await compareWithoutMmap(picked.db, open, () => compareCrawls(picked.db, open));
    return {
      filePath,
      totalA: s.totalA,
      totalB: s.totalB,
      counts: s.counts,
      samples: s.samples,
      issueChanges: s.issueChanges,
      notComparable: s.notComparable,
      mapped: s.mapped ?? { count: 0, examples: [] },
    };
  } finally {
    picked.dispose();
  }
}
