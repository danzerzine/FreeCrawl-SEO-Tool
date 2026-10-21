import { compareCrawls, openCompareProject } from '@freecrawl/core';
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
  };
}

/**
 * Compare the open project (the newer crawl, "after") with a picked file
 * ("before"). The picked project is opened by `openCompareProject`: never
 * written, an archive through a temp copy that is deleted after.
 */
export async function compareWithOpenProject(
  open: ProjectDb,
  filePath: string,
): Promise<CompareLoadResult> {
  const picked = await openCompareProject(filePath);
  try {
    const s = compareCrawls(picked.db, open);
    return {
      filePath,
      totalA: s.totalA,
      totalB: s.totalB,
      counts: s.counts,
      samples: s.samples,
      issueChanges: s.issueChanges,
      notComparable: s.notComparable,
    };
  } finally {
    picked.dispose();
  }
}
