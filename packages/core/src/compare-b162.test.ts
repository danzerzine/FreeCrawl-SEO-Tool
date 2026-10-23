import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb, RENDER_CHECKS, CONSOLE_CHECKS } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareCrawls } from './compare.js';

let dir: string;
const opened: ProjectDb[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b162-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of opened.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Cols = Record<string, number | string | null>;

/** Every render-only column with a verdict and nothing flagged. */
const CLEAN: Cols = {
  js_h1_changed: 0,
  js_canonical_changed: 0,
  js_links_changed: 0,
  js_text_changed: 0,
  console_errors: 0,
  failed_resources: 0,
  a11y_low_contrast: 0,
  a11y_focus_suppressed: 0,
  a11y_small_font: 0,
  a11y_tap_targets_small: 0,
  axe_violations: 0,
  axe_serious: 0,
  axe_incomplete: 0,
  mobile_usable: 1,
  mobile_overflow_px: 0,
  js_noindex: 0,
  js_title_changed: 0,
  render_diff: null,
};

/** A page the browser never rendered: what the crawler stores for it. */
const UNRENDERED: Cols = {
  js_h1_changed: null,
  js_canonical_changed: null,
  js_links_changed: null,
  js_text_changed: null,
  console_errors: null,
  failed_resources: null,
  a11y_low_contrast: null,
  a11y_focus_suppressed: null,
  a11y_small_font: null,
  a11y_tap_targets_small: null,
  axe_violations: null,
  axe_serious: null,
  axe_incomplete: null,
  mobile_usable: -1,
  mobile_overflow_px: 0,
  js_noindex: 0,
  js_title_changed: 0,
  render_diff: null,
};

const JS_FILLED = [...RENDER_CHECKS, ...CONSOLE_CHECKS];

/** One internal 200 HTML page per entry (id, url) with the given column values. */
function project(name: string, pages: [number, string, Cols][], filled: readonly string[] = JS_FILLED): ProjectDb {
  const file = path.join(dir, `${name}.seoproject`);
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title, h1)
     VALUES (?, ?, 0, 'html', 200, 'indexable', 'T', 'H')`,
  );
  for (const [id, url, cols] of pages) {
    ins.run(id, url);
    const names = Object.keys(cols);
    raw
      .prepare(`UPDATE urls SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE id = ?`)
      .run(...names.map((n) => cols[n]!), id);
  }
  raw
    .prepare(`INSERT OR REPLACE INTO project_meta (key, value) VALUES ('checksFilled', ?)`)
    .run(JSON.stringify(filled));
  raw.close();
  const db = new ProjectDb(file);
  opened.push(db);
  return db;
}

const U = (n: string): string => `https://ex.com/${n}`;

/** Per check: the columns that flag it, and the column(s) whose NULL / -1 means "no verdict". */
const CHECKS: { key: string; flagged: Cols; noVerdict: Cols }[] = [
  { key: 'issues:h1-changed-by-js', flagged: { js_h1_changed: 1 }, noVerdict: { js_h1_changed: null } },
  { key: 'issues:canonical-changed-by-js', flagged: { js_canonical_changed: 1 }, noVerdict: { js_canonical_changed: null } },
  { key: 'issues:links-changed-by-js', flagged: { js_links_changed: 1 }, noVerdict: { js_links_changed: null } },
  { key: 'issues:text-changed-by-js', flagged: { js_text_changed: 1 }, noVerdict: { js_text_changed: null } },
  { key: 'issues:console-errors', flagged: { console_errors: 2 }, noVerdict: { console_errors: null } },
  { key: 'issues:failed-resources', flagged: { failed_resources: 2 }, noVerdict: { failed_resources: null } },
  { key: 'issues:low-contrast-text', flagged: { a11y_low_contrast: 3 }, noVerdict: { a11y_low_contrast: null } },
  { key: 'issues:focus-outline-suppressed', flagged: { a11y_focus_suppressed: 1 }, noVerdict: { a11y_focus_suppressed: null } },
  { key: 'issues:font-too-small', flagged: { a11y_small_font: 2 }, noVerdict: { a11y_small_font: null } },
  { key: 'issues:tap-targets-too-small', flagged: { a11y_tap_targets_small: 2 }, noVerdict: { a11y_tap_targets_small: null } },
  { key: 'issues:axe-critical-serious', flagged: { axe_violations: 2, axe_serious: 2 }, noVerdict: { axe_serious: null } },
  { key: 'issues:axe-moderate-minor', flagged: { axe_violations: 3, axe_serious: 1 }, noVerdict: { axe_serious: null } },
  { key: 'issues:axe-needs-review', flagged: { axe_incomplete: 1 }, noVerdict: { axe_incomplete: null } },
  { key: 'issues:content-wider-than-screen', flagged: { mobile_usable: 0, mobile_overflow_px: 50 }, noVerdict: { mobile_usable: -1 } },
];

describe('compareCrawls: pages the browser never rendered are not "checked" (B162)', () => {
  describe.each(CHECKS)('$key', ({ key, flagged, noVerdict }) => {
    it('flagged where rendered, no verdict where not: not resolved, counted as partly compared', () => {
      const a = project('a', [[1, U('p'), { ...CLEAN, ...flagged }]]);
      const b = project('b', [[1, U('p'), { ...CLEAN, ...noVerdict }]]);
      const s = compareCrawls(a, b);
      expect(s.issueChanges[key]).toBeUndefined();
      expect(s.counts.issues).toBe(0);
      expect(s.notComparable[key]?.reason).toMatch(/partly compared/);
      expect(s.notComparable[key]?.urls).toBe(1);
    });

    it('swapped sides: not appeared', () => {
      const a = project('a', [[1, U('p'), { ...CLEAN, ...noVerdict }]]);
      const b = project('b', [[1, U('p'), { ...CLEAN, ...flagged }]]);
      const s = compareCrawls(a, b);
      expect(s.issueChanges[key]).toBeUndefined();
      expect(s.counts.issues).toBe(0);
      expect(s.notComparable[key]?.urls).toBe(1);
    });

    it('a verdict on both sides still gives resolved and appeared', () => {
      const flaggedPage = { ...CLEAN, ...flagged };
      const a = project('a', [[1, U('p'), flaggedPage]]);
      const b = project('b', [[1, U('p'), CLEAN]]);
      expect(compareCrawls(a, b).issueChanges[key]).toEqual({ appeared: 0, resolved: 1 });
      expect(compareCrawls(b, a).issueChanges[key]).toEqual({ appeared: 1, resolved: 0 });
    });
  });

  it('a skipped page does not hide a changed one: only the skipped page is counted', () => {
    const a = project('a', [
      [1, U('crashed'), { ...CLEAN, js_h1_changed: 1 }],
      [2, U('ok'), { ...CLEAN, js_h1_changed: 1 }],
    ]);
    const b = project('b', [
      [1, U('crashed'), UNRENDERED],
      [2, U('ok'), CLEAN],
    ]);
    const s = compareCrawls(a, b);
    expect(s.issueChanges['issues:h1-changed-by-js']).toEqual({ appeared: 0, resolved: 1 });
    expect(s.notComparable['issues:h1-changed-by-js']?.urls).toBe(1);
    expect(s.samples.filter((r) => r.category === 'issues').map((r) => r.url)).toEqual([U('ok')]);
  });

  it('(a) only failed_resources NULL on B: failed-resources skipped, console-errors compared', () => {
    const a = project('a', [[1, U('p'), { ...CLEAN, console_errors: 2, failed_resources: 2 }]]);
    const b = project('b', [[1, U('p'), { ...CLEAN, failed_resources: null }]]);
    const s = compareCrawls(a, b);
    expect(s.issueChanges['issues:console-errors']).toEqual({ appeared: 0, resolved: 1 });
    expect(s.issueChanges['issues:failed-resources']).toBeUndefined();
  });

  it('(b) rendered page with all js_* NULL and render_diff skipped: console, a11y and js-noindex are compared', () => {
    const skipped = { ...CLEAN, js_h1_changed: null, js_canonical_changed: null, js_links_changed: null, js_text_changed: null, render_diff: '{"skipped":"page script"}' };
    const a = project('a', [[1, U('p'), { ...skipped, console_errors: 2, a11y_low_contrast: 1, js_noindex: 2, js_title_changed: 2 }]]);
    const b = project('b', [[1, U('p'), skipped]]);
    const s = compareCrawls(a, b);
    expect(s.issueChanges['issues:console-errors']).toEqual({ appeared: 0, resolved: 1 });
    expect(s.issueChanges['issues:low-contrast-text']).toEqual({ appeared: 0, resolved: 1 });
    expect(s.issueChanges['issues:noindex-js-injected']).toEqual({ appeared: 0, resolved: 1 });
    expect(s.issueChanges['issues:title-changed-by-js']).toEqual({ appeared: 0, resolved: 1 });
  });

  describe('noindex-js-injected / title-changed-by-js verdict kind', () => {
    const textFilled: string[] = [];
    it('rendered in A, unrendered in B of a JS-mode crawl: skipped', () => {
      const a = project('a', [[1, U('p'), { ...CLEAN, js_noindex: 2, js_title_changed: 2 }]]);
      const b = project('b', [[1, U('p'), UNRENDERED]]);
      const s = compareCrawls(a, b);
      expect(s.issueChanges['issues:noindex-js-injected']).toBeUndefined();
      expect(s.issueChanges['issues:title-changed-by-js']).toBeUndefined();
      expect(s.notComparable['issues:noindex-js-injected']?.urls).toBe(1);
    });
    it('rendered in A, heuristic guess in B of a text-mode crawl: skipped', () => {
      const a = project('a', [[1, U('p'), { ...CLEAN, js_noindex: 2, js_title_changed: 2 }]]);
      const b = project('b', [[1, U('p'), { ...UNRENDERED, js_noindex: 1, js_title_changed: 1 }]], textFilled);
      const s = compareCrawls(a, b);
      expect(s.issueChanges['issues:noindex-js-injected']).toBeUndefined();
      expect(s.issueChanges['issues:title-changed-by-js']).toBeUndefined();
      expect(s.notComparable['issues:noindex-js-injected']?.urls).toBe(1);
    });
    it('text vs text: the heuristic is still compared (1 to 0 is resolved)', () => {
      const a = project('a', [[1, U('p'), { ...UNRENDERED, js_noindex: 1, js_title_changed: 1 }]], textFilled);
      const b = project('b', [[1, U('p'), UNRENDERED]], textFilled);
      const s = compareCrawls(a, b);
      expect(s.issueChanges['issues:noindex-js-injected']).toEqual({ appeared: 0, resolved: 1 });
      expect(s.issueChanges['issues:title-changed-by-js']).toEqual({ appeared: 0, resolved: 1 });
      expect(s.notComparable['issues:noindex-js-injected']).toBeUndefined();
    });
  });

  it('(d) two default crawls (audits off, both sides without a verdict): no partly-compared entry', () => {
    const page = { ...CLEAN, a11y_low_contrast: null, a11y_focus_suppressed: null, a11y_small_font: null, a11y_tap_targets_small: null, axe_violations: null, axe_serious: null, axe_incomplete: null, mobile_usable: -1 };
    const a = project('a', [[1, U('p'), page]]);
    const b = project('b', [[1, U('p'), page]]);
    const s = compareCrawls(a, b);
    const partly = Object.entries(s.notComparable).filter(([, v]) => /partly compared/.test(v.reason));
    expect(partly).toEqual([]);
  });

  it('(e) a check whose flag query failed keeps its own reason', () => {
    const a = project('a', [[1, U('p'), { ...CLEAN, js_h1_changed: 1 }]]);
    const b = project('b', [[1, U('p'), UNRENDERED]]);
    const real = b.urlIdsByCategories.bind(b);
    vi.spyOn(b, 'urlIdsByCategories').mockImplementation((cats) => {
      const m = real(cats);
      m.set('issues:h1-changed-by-js', new Error('flag query broke'));
      return m;
    });
    const s = compareCrawls(a, b);
    expect(s.notComparable['issues:h1-changed-by-js']?.reason).toBe('flag query broke');
    expect(s.issueChanges['issues:h1-changed-by-js']).toBeUndefined();
  });

  it('an older schema without the verdict columns compares as before', () => {
    const OLD_COLS = [
      'js_h1_changed', 'js_canonical_changed', 'js_links_changed', 'js_text_changed', 'render_diff',
      'console_errors', 'failed_resources', 'a11y_low_contrast', 'a11y_focus_suppressed', 'a11y_small_font',
      'a11y_tap_targets_small', 'axe_violations', 'axe_serious', 'axe_incomplete', 'mobile_usable',
    ];
    const old = (name: string, title: string | null): ProjectDb => {
      const db = project(name, [[1, U('p'), CLEAN]]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h = (db as any).db as { exec: (sql: string) => void };
      for (const c of OLD_COLS) h.exec(`ALTER TABLE urls DROP COLUMN ${c}`);
      h.exec(title === null ? 'UPDATE urls SET title = NULL' : `UPDATE urls SET title = '${title}'`);
      return db;
    };
    const a = old('a', null);
    const b = old('b', 'T');
    const s = compareCrawls(a, b);
    expect(s.issueChanges['issues:title-missing']).toEqual({ appeared: 0, resolved: 1 });
    expect(Object.values(s.notComparable).filter((v) => /partly compared/.test(v.reason))).toEqual([]);
  });
});
