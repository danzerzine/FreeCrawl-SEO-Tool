import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LATER_CHECKS, ProjectDb, RENDER_CHECKS, runMigrations } from '@freecrawl/db';
import type { OverviewCounts } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTools } from './tools.js';

let dir: string;
const opened: ProjectDb[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b137-'));
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A project file last written by an older build: migrated up to `version`, one page, opened read-only. */
const olderProject = (version: number): ProjectDb => {
  const file = path.join(dir, `v${version}.seoproject`);
  const raw = new DatabaseSync(file);
  runMigrations(raw, version);
  raw.exec(
    `INSERT INTO urls (url, is_external, content_kind, status_code, indexability, title) VALUES ('https://ex.com/', 0, 'html', 200, 'indexable', 'T')`,
  );
  raw.close();
  const db = new ProjectDb(file, { readOnly: true });
  opened.push(db);
  return db;
};
const queryUrls = (db: ProjectDb, category: string) =>
  buildTools()
    .find((t) => t.name === 'query_urls')!
    .handler({ category }, db as never) as { rows: unknown[]; total: number | null; notChecked?: boolean };

describe('module-5 checks on a project an older build made (B137, B163)', () => {
  it('before module 5: the overview lists every later check as not checked, query_urls answers "not checked" without an error', () => {
    const db = olderProject(108);
    const o = db.getOverviewCounts() as OverviewCounts;
    expect(new Set(o.notChecked)).toEqual(new Set(LATER_CHECKS));
    for (const k of LATER_CHECKS) {
      const r = queryUrls(db, k);
      expect(r, k).toMatchObject({ rows: [], total: null, notChecked: true });
    }
    // A check every build ran still lists its pages.
    expect(queryUrls(db, 'issues:meta-missing')).toMatchObject({ total: 1 });
    expect(o.notChecked).not.toContain('issues:meta-missing');
  });

  it('at v120 (before the render columns): the render checks read as not checked in the overview and in query_urls', () => {
    const db = olderProject(120);
    const o = db.getOverviewCounts() as OverviewCounts;
    for (const k of RENDER_CHECKS) {
      expect(o.notChecked, k).toContain(k);
      expect(queryUrls(db, k), k).toMatchObject({ rows: [], total: null, notChecked: true });
    }
  });

  it('a check a writable project filled is not listed', () => {
    const db = new ProjectDb(path.join(dir, 'new.seoproject'));
    opened.push(db);
    db.setMeta('checksFilled', JSON.stringify(LATER_CHECKS.filter((k) => !RENDER_CHECKS.includes(k))));
    expect(new Set(db.getOverviewCounts().notChecked)).toEqual(new Set(RENDER_CHECKS));
    expect(queryUrls(db, 'issues:h2-duplicate')).toMatchObject({ rows: [], total: 0 });
    expect(queryUrls(db, 'issues:h2-duplicate').notChecked).toBeUndefined();
  });
});
