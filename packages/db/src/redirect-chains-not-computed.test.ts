import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

let dir: string;
let file: string;

// / links /r, which redirects to the 404 /gone.
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rcnc-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, redirect_target) VALUES
      (1, 'https://ex.com/', 0, 'html', 200, 'indexable', NULL),
      (2, 'https://ex.com/r', 0, 'other', 301, 'non-indexable:redirect', 'https://ex.com/gone'),
      (3, 'https://ex.com/gone', 0, 'html', 404, 'non-indexable:client-error', NULL);
    INSERT INTO links (from_url_id, to_url, is_internal) VALUES (1, 'https://ex.com/r', 1);
  `);
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const report = (db: ProjectDb, r: 'redirects-to-error' | 'redirect-inlinks') =>
  db.linkTargetReport({ report: r, limit: 10 })?.map((x) => [x.targetUrl, x.finalUrl]) ?? null;

it('redirect reports are not computed until the redirect-chain pass runs', () => {
  const db = new ProjectDb(file);
  expect(report(db, 'redirects-to-error')).toBeNull();
  expect(report(db, 'redirect-inlinks')).toBeNull();
  db.recomputeRedirectChains();
  expect(report(db, 'redirects-to-error')).toEqual([['https://ex.com/r', 'https://ex.com/gone']]);
  expect(report(db, 'redirect-inlinks')).toEqual([['https://ex.com/r', 'https://ex.com/gone']]);
  expect(db.linkTargetReport({ report: 'error-inlinks', limit: 10 })).not.toBeNull();
  db.close();
});

it('a crawl start makes them not computed again', () => {
  const db = new ProjectDb(file);
  db.recomputeRedirectChains();
  db.markRedirectChainsStale();
  expect(report(db, 'redirects-to-error')).toBeNull();
  db.close();
});

it('a project whose chains were computed before the flag existed reads as computed', () => {
  const raw = new DatabaseSync(file);
  raw.exec(`UPDATE urls SET redirect_final_url = 'https://ex.com/gone', redirect_chain_length = 1 WHERE id = 2;
    DELETE FROM project_meta WHERE key = 'redirectChainsComputed';
    DELETE FROM schema_version WHERE version >= 105;`);
  raw.close();
  const db = new ProjectDb(file);
  expect(report(db, 'redirects-to-error')).toEqual([['https://ex.com/r', 'https://ex.com/gone']]);
  db.close();
});

it('a project that never computed chains stays not computed after reopening', () => {
  const raw = new DatabaseSync(file);
  raw.exec('DELETE FROM schema_version WHERE version >= 105;');
  raw.close();
  const db = new ProjectDb(file);
  expect(report(db, 'redirect-inlinks')).toBeNull();
  db.close();
});
