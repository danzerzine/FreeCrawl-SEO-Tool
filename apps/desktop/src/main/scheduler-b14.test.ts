import { describe, expect, it } from 'vitest';
import type { ScheduleEntry, ScheduleSpec } from '@freecrawl/shared-types';
import { getSchedule, setSchedule, type SchedulerStore } from './scheduler.js';

function memoryStore(initial: Record<string, ScheduleEntry> = {}): SchedulerStore {
  let map = structuredClone(initial);
  return { load: () => structuredClone(map), save: (m) => (map = structuredClone(m)) };
}

const base: ScheduleSpec = { enabled: true, cadence: 'daily', hourOfDay: 3, minuteOfHour: 0 };

describe('scheduler export sets (B14)', () => {
  it('keeps an export set name on save', () => {
    const store = memoryStore();
    const e = setSchedule(store, '/p.seoproject', {
      ...base,
      afterCrawl: { export: 'set', exportSet: ' weekly ', outputDir: '/out', sheets: false, webhook: false },
    });
    expect(e?.spec.afterCrawl).toEqual({
      export: 'set',
      exportSet: 'weekly',
      outputDir: '/out',
      sheets: false,
      webhook: false,
    });
  });

  it('downgrades a set export without a set name to none', () => {
    const store = memoryStore();
    const e = setSchedule(store, '/p.seoproject', {
      ...base,
      afterCrawl: { export: 'set', exportSet: '', outputDir: '/out', sheets: false, webhook: true },
    });
    expect(e?.spec.afterCrawl).toEqual({ export: 'none', outputDir: '/out', sheets: false, webhook: true });
  });

  it('a schedule stored before export sets reads and re-saves unchanged', () => {
    const old: ScheduleEntry = {
      spec: { ...base, afterCrawl: { export: 'bulk', outputDir: '/out', sheets: true, webhook: false } },
      status: { lastFiredAt: null, lastStatus: null, nextFiresAt: 1 },
    };
    const store = memoryStore({ '/p.seoproject': old });
    expect(getSchedule(store, '/p.seoproject')).toEqual(old);
    const e = setSchedule(store, '/p.seoproject', old.spec);
    expect(e?.spec).toEqual(old.spec);
  });
});
