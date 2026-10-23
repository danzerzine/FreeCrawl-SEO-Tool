import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AxeAudit, AxeRuleResult } from '@freecrawl/shared-types';
import { runMigrations } from './migrations.js';
import { ProjectDb } from './project-db.js';

const A = 'https://ex.test/a';
const B = 'https://ex.test/b';
const C = 'https://other.test/c';

const rule = (id: string, impact: string | null, over: Partial<AxeRuleResult> = {}): AxeRuleResult => ({
  id,
  impact,
  help: `help ${id}`,
  helpUrl: `https://dequeuniversity.com/rules/axe/4.14/${id}`,
  tags: ['wcag2a', 'wcag111'],
  nodes: 2,
  samples: [{ target: '#x', html: '<img src="a.png">', summary: 'Fix it' }],
  ...over,
});
const audit = (violations: AxeRuleResult[], incomplete: AxeRuleResult[] = [], over: Partial<AxeAudit> = {}): AxeAudit => ({
  version: '4.14.0',
  violations,
  incomplete,
  violationsTotal: violations.length,
  seriousTotal: violations.filter((r) => r.impact === 'critical' || r.impact === 'serious').length,
  ...over,
});

let dir: string;
let file: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b40-'));
  file = path.join(dir, 'p.seoproject');
  const raw = new DatabaseSync(file);
  runMigrations(raw);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability) VALUES
    (1, '${A}', 0, 'html', 200, 'indexable'), (2, '${B}', 0, 'html', 200, 'indexable'), (3, '${C}', 0, 'html', 200, 'indexable')`);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const raw = <T>(sql: string): T[] => {
  const r = new DatabaseSync(file, { readOnly: true });
  try {
    return r.prepare(sql).all() as T[];
  } finally {
    r.close();
  }
};
const urlRow = (id: number) =>
  raw<Record<string, unknown>>(`SELECT axe_violations, axe_serious, axe_incomplete, axe_version FROM urls WHERE id = ${id}`)[0]!;

describe('B40 migration 127', () => {
  it('127 adds the columns and the table; rows of a version-126 file survive', () => {
    const f = path.join(dir, 'old.seoproject');
    const old = new DatabaseSync(f);
    runMigrations(old, 126);
    old.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1, '${A}', 0, 'html', 200)`);
    expect(old.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'axe_results'`).get()).toBeUndefined();
    runMigrations(old);
    // Migration 127 is the one B40 adds (126 is B41's); the next free number on this branch.
    expect(old.prepare('SELECT version FROM schema_version WHERE version = 127').get()).toBeDefined();
    const cols = (old.prepare('PRAGMA table_info(urls)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['axe_violations', 'axe_serious', 'axe_incomplete', 'axe_version']));
    expect(old.prepare('SELECT url FROM urls').all()).toEqual([{ url: A }]);
    expect(old.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'axe_results'`).get()).toBeDefined();
    old.close();
  });
});

describe('B40 R8, R9: setUrlAxe', () => {
  it('stores the counts on the url and one row per rule; NULL stays for a page never audited', () => {
    db.setUrlAxe(1, audit([rule('image-alt', 'critical'), rule('color-contrast', 'serious'), rule('region', 'moderate')], [rule('aria-valid-attr-value', null)]));
    expect(urlRow(1)).toEqual({ axe_violations: 3, axe_serious: 2, axe_incomplete: 1, axe_version: '4.14.0' });
    expect(urlRow(2)).toEqual({ axe_violations: null, axe_serious: null, axe_incomplete: null, axe_version: null });
    const rows = raw<{ rule_id: string; kind: string; impact: string | null; nodes: number; tags: string }>(
      'SELECT rule_id, kind, impact, nodes, tags FROM axe_results WHERE url_id = 1 ORDER BY rule_id',
    );
    expect(rows.map((r) => [r.rule_id, r.kind])).toEqual([
      ['aria-valid-attr-value', 'incomplete'],
      ['color-contrast', 'violation'],
      ['image-alt', 'violation'],
      ['region', 'violation'],
    ]);
    expect(rows.find((r) => r.rule_id === 'image-alt')).toMatchObject({ impact: 'critical', nodes: 2, tags: 'wcag2a,wcag111' });
  });

  it('audited and clean is 0, not NULL', () => {
    db.setUrlAxe(1, audit([]));
    expect(urlRow(1)).toEqual({ axe_violations: 0, axe_serious: 0, axe_incomplete: 0, axe_version: '4.14.0' });
    expect(raw('SELECT * FROM axe_results')).toEqual([]);
  });

  it('counts the violations the cap did not store (violationsTotal, seriousTotal)', () => {
    db.setUrlAxe(1, audit([rule('a', 'serious')], [], { violationsTotal: 130, seriousTotal: 77 }));
    expect(urlRow(1)).toMatchObject({ axe_violations: 130, axe_serious: 77 });
  });

  it('a re-render replaces the old rows of the page and leaves other pages alone', () => {
    db.setUrlAxe(1, audit([rule('image-alt', 'critical')]));
    db.setUrlAxe(2, audit([rule('button-name', 'critical')]));
    db.setUrlAxe(1, audit([rule('region', 'moderate')]));
    expect(raw<{ rule_id: string }>('SELECT rule_id FROM axe_results WHERE url_id = 1')).toEqual([{ rule_id: 'region' }]);
    expect(raw<{ rule_id: string }>('SELECT rule_id FROM axe_results WHERE url_id = 2')).toEqual([{ rule_id: 'button-name' }]);
    expect(urlRow(1)).toMatchObject({ axe_violations: 1, axe_serious: 0 });
  });

  it('null (axe on, no result) clears the old columns and rows so a stale result never sits beside a fresh DOM', () => {
    db.setUrlAxe(1, audit([rule('image-alt', 'critical')]));
    db.setUrlAxe(1, null);
    expect(urlRow(1)).toEqual({ axe_violations: null, axe_serious: null, axe_incomplete: null, axe_version: null });
    expect(raw('SELECT * FROM axe_results WHERE url_id = 1')).toEqual([]);
  });

  it('is atomic: a failing insert leaves the previous result', () => {
    db.setUrlAxe(1, audit([rule('image-alt', 'critical')]));
    const bad = audit([rule('x', 'serious', { nodes: Number.NaN })]);
    (bad.violations[0] as { id: unknown }).id = null; // violates NOT NULL on rule_id
    expect(() => db.setUrlAxe(1, bad)).toThrow();
    expect(urlRow(1)).toMatchObject({ axe_violations: 1 });
    expect(raw<{ rule_id: string }>('SELECT rule_id FROM axe_results WHERE url_id = 1')).toEqual([{ rule_id: 'image-alt' }]);
  });
});

describe('B40 queryAxe', () => {
  beforeEach(() => {
    db.setUrlAxe(1, audit([rule('image-alt', 'critical', { nodes: 5 }), rule('region', 'moderate'), rule('color-contrast', 'serious', { nodes: 9 })], [rule('aria-hidden-focus', null)]));
    db.setUrlAxe(2, audit([rule('image-alt', 'critical', { nodes: 1 })]));
  });
  const q = (p: Partial<Parameters<ProjectDb['queryAxe']>[0]> = {}) => db.queryAxe({ limit: 100, offset: 0, ...p });

  it('returns rows with the url, tags as a list and samples parsed, worst impact first', () => {
    const { rows, total } = q({ url: A });
    expect(total).toBe(4);
    expect(rows.map((r) => r.ruleId)).toEqual(['image-alt', 'color-contrast', 'region', 'aria-hidden-focus']);
    expect(rows[0]).toMatchObject({ url: A, kind: 'violation', impact: 'critical', nodes: 5, tags: ['wcag2a', 'wcag111'] });
    expect(rows[0]!.samples[0]).toMatchObject({ target: '#x' });
    expect(rows[3]).toMatchObject({ kind: 'incomplete', impact: null });
  });

  it('filters by impact, rule id and kind, and pages', () => {
    expect(q({ impact: 'critical' }).rows.map((r) => r.url + r.ruleId)).toEqual([A + 'image-alt', B + 'image-alt']);
    expect(q({ ruleId: 'region' }).total).toBe(1);
    expect(q({ kind: 'incomplete' }).total).toBe(1);
    expect(q({ limit: 2, offset: 0 }).rows).toHaveLength(2);
    expect(q({ limit: 2, offset: 4 }).rows).toHaveLength(1);
    expect(q({ limit: 2, offset: 4 }).total).toBe(5);
  });

  it('a page with no url filter lists all pages; an unknown url lists nothing', () => {
    expect(q().total).toBe(5);
    expect(q({ url: C })).toEqual({ rows: [], total: 0 });
  });
});

describe('B40 R9, R11: issue categories count only audited pages, never needs-review as violations', () => {
  it('critical/serious, moderate/minor and needs-review are three separate filters', () => {
    db.setUrlAxe(1, audit([rule('image-alt', 'critical'), rule('region', 'moderate')], [rule('aria-hidden-focus', null)]));
    db.setUrlAxe(2, audit([rule('region', 'minor')]));
    db.setUrlAxe(3, audit([], [rule('x', null)]));
    const list = (cat: string) => [...db.iterateUrlsByCategory(cat as never)].map((r) => (r as { url: string }).url).sort();
    expect(list('issues:axe-critical-serious')).toEqual([A]);
    expect(list('issues:axe-moderate-minor')).toEqual([A, B]);
    expect(list('issues:axe-needs-review')).toEqual([A, C]);
    const counts = db.getOverviewCounts().issues as unknown as Record<string, number>;
    expect(counts.axeCriticalSerious).toBe(1);
    expect(counts.axeModerateMinor).toBe(2);
    expect(counts.axeNeedsReview).toBe(2);
  });

  it('a never-audited page (NULL) and a clean one (0) are in no axe filter', () => {
    db.setUrlAxe(2, audit([]));
    const counts = db.getOverviewCounts().issues as unknown as Record<string, number>;
    expect((counts.axeCriticalSerious ?? 0) + (counts.axeModerateMinor ?? 0) + (counts.axeNeedsReview ?? 0)).toBe(0);
  });

  it('a page that is not 2xx any more is not counted', () => {
    db.setUrlAxe(1, audit([rule('image-alt', 'critical')]));
    const w = new DatabaseSync(file);
    w.exec('UPDATE urls SET status_code = 404 WHERE id = 1');
    w.close();
    const counts = db.getOverviewCounts().issues as unknown as Record<string, number>;
    expect(counts.axeCriticalSerious).toBe(0);
  });

  it('the url row carries the axe counts (get_url_detail reads them)', () => {
    db.setUrlAxe(1, audit([rule('image-alt', 'critical')], [rule('x', null)]));
    const d = db.getUrlDetail(1)!;
    expect(d.row).toMatchObject({ axeViolations: 1, axeSerious: 1, axeIncomplete: 1, axeVersion: '4.14.0' });
    expect(db.getUrlDetail(2)!.row).toMatchObject({ axeViolations: null, axeSerious: null });
  });
});

describe('B40 H4: axe_results holds page HTML and is deleted explicitly, not left to a cascade', () => {
  const left = () => raw<{ n: number }>('SELECT COUNT(*) AS n FROM axe_results')[0]!.n;
  beforeEach(() => {
    for (const id of [1, 2, 3]) db.setUrlAxe(id, audit([rule('image-alt', 'critical')]));
    expect(left()).toBe(3);
  });

  it('deleteUrl', () => {
    db.deleteUrl(1);
    expect(raw<{ url_id: number }>('SELECT url_id FROM axe_results ORDER BY url_id').map((r) => r.url_id)).toEqual([2, 3]);
  });

  it('deleteUrl with foreign keys off still removes the rows', () => {
    const w = new DatabaseSync(file);
    w.exec('PRAGMA foreign_keys = OFF');
    w.close();
    (db as unknown as { db: DatabaseSync }).db.exec('PRAGMA foreign_keys = OFF');
    db.deleteUrl(1);
    expect(raw<{ url_id: number }>('SELECT url_id FROM axe_results ORDER BY url_id').map((r) => r.url_id)).toEqual([2, 3]);
  });

  it('deleteUrls', () => {
    db.deleteUrls([1, 2]);
    expect(raw<{ url_id: number }>('SELECT url_id FROM axe_results').map((r) => r.url_id)).toEqual([3]);
  });

  it('deleteByDomain (foreign keys are switched off inside it)', () => {
    db.deleteByDomain('ex.test');
    expect(raw<{ url_id: number }>('SELECT url_id FROM axe_results').map((r) => r.url_id)).toEqual([3]);
  });

  it('reset (foreign keys are switched off inside it)', () => {
    db.reset();
    expect(left()).toBe(0);
  });
});
