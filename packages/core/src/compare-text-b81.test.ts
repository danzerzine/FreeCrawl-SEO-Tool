import { describe, expect, it } from 'vitest';
import { compareChangesText, type CompareSummary } from './compare.js';

const summary = (counts: Record<string, number>, issues = 0): CompareSummary =>
  ({
    totalA: 3,
    totalB: 2,
    counts,
    samples: [],
    issueChanges: Object.fromEntries(Array.from({ length: issues }, (_, i) => [`issues:k${i}`, { resolved: 1, appeared: 0 }])),
    notComparable: {},
  }) as unknown as CompareSummary;

describe('compareChangesText (B81)', () => {
  it('lists the kinds that changed and the number of checks', () => {
    expect(compareChangesText(summary({ added: 0, removed: 1, title: 2 }, 3))).toBe(
      'Changes since the previous crawl (3 → 2 URLs): removed 1, title 2; checks changed: 3.',
    );
  });
  it('says so when nothing changed', () => {
    expect(compareChangesText(summary({ added: 0, title: 0 }))).toBe(
      'Changes since the previous crawl (3 → 2 URLs): none.',
    );
  });
});
