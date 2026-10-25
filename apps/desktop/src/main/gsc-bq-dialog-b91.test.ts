import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GscBqPlanView } from '@freecrawl/shared-types';
import { daysToPull, needsFreshPlan, pullGate, pullingPart } from '@freecrawl/shared-types';

const plan = (over: Partial<GscBqPlanView> = {}): GscBqPlanView => ({
  planId: 'p1',
  location: 'EU',
  siteUrl: 'sc-domain:ex.test',
  searchType: 'web',
  range: { start: '2026-10-01', end: '2026-10-03' },
  parts: [{ start: '2026-10-01', end: '2026-10-03', days: 3, estimate: 1 }],
  coveredDays: 3,
  missingDays: 0,
  revisedDays: [],
  firstCovered: '2026-10-01',
  lastCovered: '2026-10-03',
  totalEstimate: 1,
  freeTierShare: 0,
  capBytes: 10,
  billedSoFar: 0,
  overCap: false,
  needsReset: false,
  rebuild: false,
  canRun: true,
  ...over,
});

describe('GscBqPullDialog rules (review r1)', () => {
  it('first pull on a contiguous export (0 export gaps) can be pulled and is not "nothing new"', () => {
    const g = pullGate(plan({ missingDays: 0 }), false);
    expect(g.canPull).toBe(true);
    expect(g.upToDate).toBe(false);
  });

  it('no parts left: nothing new, Pull disabled', () => {
    const g = pullGate(plan({ parts: [], missingDays: 2 }), false);
    expect(g).toMatchObject({ canPull: false, upToDate: true });
  });

  it('export gaps do not disable Pull when parts exist', () => {
    expect(pullGate(plan({ missingDays: 5 }), false).canPull).toBe(true);
  });

  it('the real count of days to pull is the sum of the parts, not covered or missing', () => {
    const p = plan({
      parts: [
        { start: '2026-10-01', end: '2026-10-02', days: 2, estimate: 1 },
        { start: '2026-10-05', end: '2026-10-05', days: 1, estimate: 1 },
      ],
      coveredDays: 9,
      missingDays: 4,
    });
    expect(daysToPull(p)).toBe(3);
  });

  it('needsReset: Pull stays off until the box is ticked, then on (canRun is false there)', () => {
    const p = plan({ needsReset: true, canRun: false });
    expect(pullGate(p, false).canPull).toBe(false);
    expect(pullGate(p, true).canPull).toBe(true);
    expect(pullGate({ ...p, overCap: true }, true).canPull).toBe(false);
    expect(pullGate({ ...p, parts: [] }, true).canPull).toBe(false);
  });

  it('over the cap: Pull off', () => {
    expect(pullGate(plan({ overCap: true, canRun: false }), false).canPull).toBe(false);
  });

  it('revised days offer Rebuild; a plan that needs a reset does not (it has its own box)', () => {
    expect(pullGate(plan({ revisedDays: ['2026-10-01'] }), false).canRebuild).toBe(true);
    expect(pullGate(plan(), false).canRebuild).toBe(false);
    expect(pullGate(plan({ revisedDays: ['2026-10-01'], needsReset: true }), false).canRebuild).toBe(false);
    expect(pullGate(plan({ revisedDays: ['2026-10-01'], rebuild: true }), false).canRebuild).toBe(false); // already previewed
  });

  it('record-empty and reset run on a fresh plan; a Rebuild plan runs as shown; a plain first Pull on the one shown', () => {
    expect(needsFreshPlan(plan(), { recordEmpty: false })).toBe(false);
    expect(needsFreshPlan(plan(), { recordEmpty: true })).toBe(true);
    expect(needsFreshPlan(plan({ rebuild: true }), { recordEmpty: false })).toBe(false);
    expect(needsFreshPlan(plan({ needsReset: true }), { recordEmpty: false })).toBe(true);
  });
});

describe('coverage label (review r1)', () => {
  const dir = path.resolve(__dirname, '../renderer/src/i18n/locales');
  const LOCALES = ['az', 'en', 'es', 'fr', 'hi', 'it', 'ko', 'pt-BR', 'ru', 'tr', 'zh-CN'];
  for (const l of LOCALES) {
    it(`${l}: names export days and days to pull with all four numbers`, () => {
      const v = JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), 'utf8')).gscBq.coverage as string;
      for (const k of ['covered', 'missing', 'pull', 'parts']) expect(v).toContain(`{{${k}}}`);
    });
  }
  it('en and ru no longer say "already pulled" for export days', () => {
    const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8')).gscBq.coverage as string;
    const ru = JSON.parse(fs.readFileSync(path.join(dir, 'ru.json'), 'utf8')).gscBq.coverage as string;
    expect(en).not.toMatch(/already pulled/);
    expect(en).toMatch(/export/i);
    expect(ru).not.toMatch(/Уже загружено/);
    expect(ru).toMatch(/экспорт/i);
  });
  it('the over-cap text does not promise a continued pull', () => {
    for (const l of LOCALES) {
      const en = JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), 'utf8')).gscBq.overCap as string;
      expect(en.length).toBeGreaterThan(10);
    }
    const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8')).gscBq.overCap as string;
    expect(en).not.toMatch(/continued/);
  });
});

describe('the progress line names the part being pulled (review r1)', () => {
  it('counts parts from 1: nothing done yet is part 1, the last one never passes the total', () => {
    expect(pullingPart(0, 3)).toBe(1);
    expect(pullingPart(1, 3)).toBe(2);
    expect(pullingPart(3, 3)).toBe(3);
    expect(pullingPart(0, 0)).toBe(0);
  });

  it('the dialog shows that number, not the count of finished parts', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../renderer/src/components/GscBqPullDialog.tsx'),
      'utf8',
    );
    expect(src).toMatch(/done:\s*pullingPart\(/);
    expect(src).not.toMatch(/done:\s*progress\?\.done/);
  });
});

describe('the cancel line is translated, not the raw main-process English', () => {
  const root = path.resolve(__dirname, '../renderer/src');
  const LOCALES = ['az', 'en', 'es', 'fr', 'hi', 'it', 'ko', 'pt-BR', 'ru', 'tr', 'zh-CN'];
  const text = (l: string): string | undefined =>
    JSON.parse(fs.readFileSync(path.join(root, `i18n/locales/${l}.json`), 'utf8')).gscBq?.stoppedCancelled;
  it('the dialog picks gscBq.stoppedCancelled for a cancelled stop', () => {
    const src = fs.readFileSync(path.join(root, 'components/GscBqPullDialog.tsx'), 'utf8');
    expect(src).toContain("t('gscBq.stoppedCancelled'");
    expect(src).toMatch(/reason === 'cancelled'/);
  });
  it('all 11 locales have it; en is the main-process wording, ru is Russian', () => {
    for (const l of LOCALES) expect(typeof text(l), l).toBe('string');
    expect(text('en')).toBe('Cancelled; the finished parts stay saved.');
    expect(text('ru')).toMatch(/[а-я]/i);
  });
});

describe('the cap and source-changed stops are translated too (B183)', () => {
  const root = path.resolve(__dirname, '../renderer/src');
  const LOCALES = ['az', 'en', 'es', 'fr', 'hi', 'it', 'ko', 'pt-BR', 'ru', 'tr', 'zh-CN'];
  const run = fs.readFileSync(path.resolve(__dirname, 'gsc-bigquery-run.ts'), 'utf8');
  const mainText = (reason: string): string =>
    new RegExp(`stop\\('${reason}', '([^']*)'\\)`).exec(run)![1] as string;
  const text = (l: string, key: string): string | undefined =>
    JSON.parse(fs.readFileSync(path.join(root, `i18n/locales/${l}.json`), 'utf8')).gscBq?.[key];
  for (const [reason, key] of [['cap', 'stoppedCap'], ['source-changed', 'stoppedSourceChanged']] as const) {
    it(`${reason}: the dialog picks gscBq.${key}; every locale has it, en is the main-process wording`, () => {
      const src = fs.readFileSync(path.join(root, 'components/GscBqPullDialog.tsx'), 'utf8');
      expect(src).toContain(`reason === '${reason}'`);
      expect(src).toContain(`t('gscBq.${key}'`);
      for (const l of LOCALES) expect(typeof text(l, key), l).toBe('string');
      expect(text('en', key)).toBe(mainText(reason));
      expect(text('ru', key)).toMatch(/[а-я]/i);
      for (const l of LOCALES.filter((x) => x !== 'en')) expect(text(l, key), l).not.toBe(text('en', key));
    });
  }
});
