import { describe, expect, it } from 'vitest';
import type { ScheduleEntry, ScheduleSpec } from '@freecrawl/shared-types';
import { setSchedule, type SchedulerStore } from './scheduler.js';

function memoryStore(initial: Record<string, ScheduleEntry> = {}): SchedulerStore {
  let map = structuredClone(initial);
  return { load: () => structuredClone(map), save: (m) => (map = structuredClone(m)) };
}

const base: ScheduleSpec = { enabled: true, cadence: 'daily', hourOfDay: 3, minuteOfHour: 0 };

describe('scheduler change report (B81)', () => {
  it('a change report alone keeps the after-crawl block', () => {
    const e = setSchedule(memoryStore(), '/p.seoproject', {
      ...base,
      afterCrawl: { export: 'none', outputDir: '/out', sheets: false, webhook: false, compare: true },
    });
    expect(e?.spec.afterCrawl).toEqual({ export: 'none', outputDir: '/out', sheets: false, webhook: false, compare: true });
  });

  it('compare off is not stored', () => {
    const e = setSchedule(memoryStore(), '/p.seoproject', {
      ...base,
      afterCrawl: { export: 'bulk', outputDir: '/out', sheets: false, webhook: false, compare: false },
    });
    expect(e?.spec.afterCrawl).toEqual({ export: 'bulk', outputDir: '/out', sheets: false, webhook: false });
  });
});
