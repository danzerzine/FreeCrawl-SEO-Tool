import { describe, expect, it } from 'vitest';
import type { CrawlSnapshot } from '@freecrawl/shared-types';
import { evaluateRules, gateFails, parseRules, type AlertRuleResult } from './rules.js';

/** A snapshot holding only what the rules below read. */
function snap(indexable: number | undefined, byStatus: Record<string, number> = {}): CrawlSnapshot {
  return {
    version: 1,
    summary: { byStatus },
    counts: { indexability: { indexable } },
    disabledChecks: [],
  } as unknown as CrawlSnapshot;
}

/** The rule file from the spec («Decisions taken»). */
const SPEC_FILE = {
  version: 1,
  rules: [
    { name: 'No server errors', metric: 'status.5xx', op: '>', value: 0 },
    { name: 'Indexable pages drop', metric: 'indexable', vs: 'previous', change: 'percent', op: '<=', value: -10 },
    { name: 'More 404s', metric: 'status.404', vs: 'previous', op: '>', value: 50, level: 'warn' },
  ],
};

describe('parseRules', () => {
  it('reads the spec example with defaults filled in', () => {
    expect(parseRules(SPEC_FILE)).toEqual([
      { name: 'No server errors', metric: 'status.5xx', vs: 'absolute', change: 'count', op: '>', value: 0, level: 'fail' },
      { name: 'Indexable pages drop', metric: 'indexable', vs: 'previous', change: 'percent', op: '<=', value: -10, level: 'fail' },
      { name: 'More 404s', metric: 'status.404', vs: 'previous', change: 'count', op: '>', value: 50, level: 'warn' },
    ]);
  });

  const ok = { name: 'R', metric: 'status.5xx', op: '>', value: 0 };
  it.each([
    ['bad op', { ...ok, op: '=>' }, /rules\[1\].*op.*=>.*>, >=, <, <=, ==, !=/],
    ['unknown metric', { ...ok, metric: 'status.5x' }, /rules\[1\].*Unknown metric: status\.5x\..*indexable/],
    ['the status.<code> placeholder', { ...ok, metric: 'status.<code>' }, /rules\[1\].*Unknown metric: status\.<code>\./],
    ['percent without previous', { ...ok, change: 'percent' }, /rules\[1\].*percent.*previous/],
    ['non-number value', { ...ok, value: '0' }, /rules\[1\].*value/],
    ['bad level', { ...ok, level: 'error' }, /rules\[1\].*level/],
  ])('rejects %s with the rule index', (_label, bad, msg) => {
    expect(() => parseRules({ version: 1, rules: [ok, bad] })).toThrow(msg);
  });

  it.each([
    ['not an object', null],
    ['wrong version', { version: 2, rules: [] }],
    ['no rules list', { version: 1 }],
  ])('rejects a file that is %s', (_label, file) => {
    expect(() => parseRules(file)).toThrow(/"version": 1|"rules" list/);
  });
});

describe('evaluateRules', () => {
  const absolute = parseRules({ version: 1, rules: [{ name: 'Has 404', metric: 'status.404', op: '>', value: 0 }] });

  it.each([
    ['fired', 3],
    ['pass', 0],
  ] as const)('absolute rule: %s', (status, count) => {
    const [r] = evaluateRules(absolute, snap(10, { '404': count }), null);
    expect(r).toMatchObject({ name: 'Has 404', status, current: count, threshold: { op: '>', value: 0 } });
  });

  // SPEC_FILE rules: [1] indexable drop <= -10%, [2] 404s up by more than 50 (warn).
  const spec = parseRules(SPEC_FILE);
  it.each([
    ['percent drop of 20% fires', 1, snap(80), snap(100), { status: 'fired', previous: 100, current: 80, change: -20, changeUnit: 'percent' }],
    ['percent drop of 5% passes', 1, snap(95), snap(100), { status: 'pass', change: -5 }],
    ['count rise of 60 fires', 2, snap(1, { '404': 70 }), snap(1, { '404': 10 }), { status: 'fired', change: 60, changeUnit: 'count', level: 'warn' }],
    ['count rise of 50 passes', 2, snap(1, { '404': 60 }), snap(1, { '404': 10 }), { status: 'pass', change: 50 }],
    ['no previous crawl is skipped', 1, snap(80), null, { status: 'skipped', previous: null, change: null }],
    ['previous 0 with percent is skipped', 1, snap(80), snap(0), { status: 'skipped', previous: 0, change: null }],
    ['not computed now is an error', 1, snap(undefined), snap(100), { status: 'error', current: null }],
    ['not computed in the previous crawl is an error', 1, snap(80), snap(undefined), { status: 'error', previous: null }],
  ] as const)('%s', (_label, i, current, previous, want) => {
    expect(evaluateRules([spec[i]!], current, previous)[0]).toMatchObject(want);
  });
});

describe('gateFails', () => {
  const r = (level: 'fail' | 'warn', status: AlertRuleResult['status']) =>
    ({ level, status }) as AlertRuleResult;
  it.each([
    ['all pass or skipped', [r('fail', 'pass'), r('fail', 'skipped')], false],
    ['only a warn rule fired or errored', [r('warn', 'fired'), r('warn', 'error')], false],
    ['a fail rule fired', [r('warn', 'pass'), r('fail', 'fired')], true],
    ['a fail rule errored (silenced check)', [r('fail', 'error')], true],
  ] as const)('%s', (_label, results, want) => {
    expect(gateFails([...results])).toBe(want);
  });
});

it('a fail rule the previous crawl could not compute fails the gate', () => {
  const [rule] = parseRules({ version: 1, rules: [{ name: 'Drop', metric: 'indexable', vs: 'previous', op: '<', value: 0 }] });
  expect(gateFails(evaluateRules([rule!], snap(80), snap(undefined)))).toBe(true);
});
