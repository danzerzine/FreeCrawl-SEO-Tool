import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CompareSummary } from '@freecrawl/core';
import type { ScheduleEntry } from '@freecrawl/shared-types';
import {
  launchScheduledCrawl,
  saveAfterScheduledCrawl,
  scheduledChangeReport,
  webhookChanges,
  type ScheduledLaunchDeps,
} from './scheduled-chain.js';
import { recordFireResult } from './scheduler.js';

const summary = (over: Partial<CompareSummary> = {}): CompareSummary =>
  ({
    totalA: 10,
    totalB: 12,
    counts: { added: 2, removed: 0 },
    samples: [],
    issueChanges: { 'issues:title-missing': { appeared: 1, resolved: 0 } },
    notComparable: { 'issues:js-x': { reason: 'not rendered' } },
    mapped: { count: 0, examples: [] },
    ...over,
  }) as unknown as CompareSummary;

function launchDeps(over: Partial<ScheduledLaunchDeps> = {}) {
  const calls: string[] = [];
  const deps: ScheduledLaunchDeps = {
    keepPreviousCrawl: async () => void calls.push('copy'),
    crawlActive: () => false,
    launch: () => void calls.push('launch'),
    recordSkipped: () => void calls.push('skipped'),
    log: (level, message) => void calls.push(`${level}:${message.slice(0, 24)}`),
    ...over,
  };
  return { deps, calls };
}

describe('launchScheduledCrawl', () => {
  it('copies the project before the crawl starts', async () => {
    const { deps, calls } = launchDeps();
    expect(await launchScheduledCrawl(deps, '/p.seoproject', true)).toBe('launched');
    expect(calls).toEqual(['copy', 'launch']);
  });

  it('copies nothing when no change report is asked for', async () => {
    const { deps, calls } = launchDeps();
    await launchScheduledCrawl(deps, '/p.seoproject', false);
    expect(calls).toEqual(['launch']);
  });

  it('a failed copy only costs the report: the crawl still starts, with a warning', async () => {
    const { deps, calls } = launchDeps({ keepPreviousCrawl: async () => { throw new Error('disk full'); } });
    expect(await launchScheduledCrawl(deps, '/p.seoproject', true)).toBe('launched');
    expect(calls[0]).toMatch(/^warn:/);
    expect(calls.at(-1)).toBe('launch');
  });

  it('a crawl started by hand while the copy runs wins; the skip is recorded and logged', async () => {
    let active = false;
    const { deps, calls } = launchDeps({
      keepPreviousCrawl: async () => {
        active = true; // the user pressed Start during the copy
      },
      crawlActive: () => active,
    });
    expect(await launchScheduledCrawl(deps, '/p.seoproject', true)).toBe('skipped');
    expect(calls).toContain('skipped');
    expect(calls).not.toContain('launch');
    expect(calls.some((c) => c.startsWith('warn:Scheduled crawl skipped'.slice(0, 24)))).toBe(true);
  });
});

describe('scheduledChangeReport', () => {
  it('logs the change text and gives the deferred alert the report as its footer', async () => {
    const alert = vi.fn();
    const log = vi.fn();
    const s = summary();
    const res = await scheduledChangeReport({ runChangeReport: async () => s, alert, log });
    expect(res).toEqual({ changes: s, error: null });
    expect(alert).toHaveBeenCalledWith({ footer: expect.stringContaining('Changes since the previous crawl (10 → 12 URLs)'), footerChanged: true });
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('checks changed: 1'));
  });

  it('no changes at all: the footer says none and does not count as changed', async () => {
    const alert = vi.fn();
    await scheduledChangeReport({
      runChangeReport: async () => summary({ counts: { added: 0 } as never, issueChanges: {} }),
      alert,
      log: vi.fn(),
    });
    expect(alert).toHaveBeenCalledWith({ footer: expect.stringContaining('none.'), footerChanged: false });
  });

  it('without a copy the report is skipped, logged, and the alert still goes out without a footer', async () => {
    const alert = vi.fn();
    const log = vi.fn();
    const res = await scheduledChangeReport({ runChangeReport: async () => null, alert, log });
    expect(res).toEqual({ changes: null, error: null });
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('Change report skipped'));
    expect(alert).toHaveBeenCalledWith({ footer: undefined, footerChanged: false });
  });

  it('a failing report becomes an error line, not an exception, and the alert still goes out', async () => {
    const alert = vi.fn();
    const log = vi.fn();
    const res = await scheduledChangeReport({
      runChangeReport: async () => {
        throw new Error('boom');
      },
      alert,
      log,
    });
    expect(res).toEqual({ changes: null, error: 'compare: boom' });
    expect(log).toHaveBeenCalledWith('warn', 'Change report failed: boom');
    expect(alert).toHaveBeenCalledTimes(1);
  });
});

describe('webhookChanges', () => {
  it('carries both totals, the counts, the number of changed checks and the checks that cannot be compared', () => {
    expect(webhookChanges(summary())).toEqual({
      totalBefore: 10,
      totalAfter: 12,
      counts: { added: 2, removed: 0 },
      checksChanged: 1,
      notComparable: ['issues:js-x'],
    });
  });
  it('is null without a change report', () => {
    expect(webhookChanges(null)).toBeNull();
  });
});

describe('saveAfterScheduledCrawl', () => {
  function saveDeps(over: Partial<Parameters<typeof saveAfterScheduledCrawl>[0]> = {}) {
    const state = { inFlight: false, seen: [] as boolean[] };
    const deps = {
      saveInFlight: () => state.inFlight,
      setSaveInFlight: (v: boolean) => {
        state.inFlight = v;
        state.seen.push(v);
      },
      save: async () => {},
      log: vi.fn(),
      ...over,
    };
    return { deps, state };
  }
  it('saves with the flag held, then released', async () => {
    const { deps, state } = saveDeps();
    expect(await saveAfterScheduledCrawl(deps)).toBe('saved');
    expect(state.seen).toEqual([true, false]);
  });
  it('does nothing while another save runs', async () => {
    const save = vi.fn();
    const { deps } = saveDeps({ saveInFlight: () => true, save });
    expect(await saveAfterScheduledCrawl(deps)).toBe('skipped');
    expect(save).not.toHaveBeenCalled();
  });
  it('a failed save is logged and the flag is released', async () => {
    const { deps, state } = saveDeps({ save: async () => { throw new Error('locked'); } });
    expect(await saveAfterScheduledCrawl(deps)).toBe('failed');
    expect(state.inFlight).toBe(false);
    expect(deps.log).toHaveBeenCalledWith('warn', 'Save after the scheduled crawl failed: locked');
  });
});

describe('the main process runs the chain through these functions', () => {
  const main = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
  it('uses each step and records a skipped run in the schedule status', () => {
    for (const call of ['launchScheduledCrawl(', 'scheduledChangeReport(', 'webhookChanges(changes)', 'saveAfterScheduledCrawl(']) {
      expect(main, call).toContain(call);
    }
    expect(main).toContain("recordFireResult(schedulerStore, projectPath, 'skipped')");
  });
  it('recordFireResult stores a skipped run', () => {
    let map: Record<string, ScheduleEntry> = {
      '/p': { spec: { enabled: true, cadence: 'daily' }, status: { lastFiredAt: 1, lastStatus: 'running', nextFiresAt: 2 } },
    };
    recordFireResult({ load: () => map, save: (m) => void (map = m) }, '/p', 'skipped');
    expect(map['/p']!.status.lastStatus).toBe('skipped');
  });
});
