import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

let dir: string;
let file: string;
const U = (p: string) => `https://ex.com${p}`;

/*
 * / links /t, /x, /r, /c, /u (rel=ugc), /s (rel=sponsored) and /k (two
 * different canonicals, so it passes nothing). /r redirects to /t; /c is
 * canonicalised to /t and links /y; /t, /x and /u link back to /.
 * Without the redirect and the canonical, /t and /x are mirror images.
 */
function build(passOn: boolean) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b125-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, is_external, content_kind, status_code, redirect_target, canonical_resolved, canonical_distinct_count) VALUES
      (1, '${U('/')}', 0, 'html', 200, NULL, NULL, 0),
      (2, '${U('/t')}', 0, 'html', 200, NULL, NULL, 0),
      (3, '${U('/x')}', 0, 'html', 200, NULL, NULL, 0),
      (4, '${U('/r')}', 0, 'html', ${passOn ? 301 : 200}, ${passOn ? `'${U('/t')}'` : 'NULL'}, NULL, 0),
      (5, '${U('/c')}', 0, 'html', 200, NULL, ${passOn ? `'${U('/t')}'` : 'NULL'}, ${passOn ? 1 : 0}),
      (6, '${U('/u')}', 0, 'html', 200, NULL, NULL, 0),
      (7, '${U('/y')}', 0, 'html', 200, NULL, NULL, 0),
      (8, '${U('/s')}', 0, 'html', 200, NULL, NULL, 0),
      (9, '${U('/k')}', 0, 'html', 200, NULL, '${U('/t')}', 2);
    INSERT INTO links (from_url_id, to_url, is_internal, rel) VALUES
      (1, '${U('/t')}', 1, NULL), (1, '${U('/x')}', 1, NULL), (1, '${U('/r')}', 1, NULL),
      (1, '${U('/c')}', 1, NULL), (1, '${U('/u')}', 1, 'ugc'),
      (1, '${U('/s')}', 1, 'sponsored'), (1, '${U('/k')}', 1, NULL),
      (5, '${U('/y')}', 1, NULL),
      (2, '${U('/')}', 1, NULL), (3, '${U('/')}', 1, NULL), (6, '${U('/')}', 1, NULL);
  `);
  raw.close();
}
beforeEach(() => {
  dir = '';
});
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function scores(passOn: boolean, countNofollow = false): Map<string, number | null> {
  build(passOn);
  const db = new ProjectDb(file);
  if (countNofollow) db.setMeta('countNofollowLinks', '1');
  db.recomputeLinkScore();
  const rows = new Map([...db.iterateUrlsByCategory('all')].map((r) => [r.url, r.linkScore]));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  dir = '';
  return rows;
}

it('a redirect and a canonicalised page pass their score to the target and keep none (B125)', () => {
  const plain = scores(false);
  expect(plain.get(U('/t'))).toBe(plain.get(U('/x')));
  const s = scores(true);
  expect(s.get(U('/r'))).toBeNull();
  expect(s.get(U('/c'))).toBeNull();
  expect(s.get(U('/t'))!).toBeGreaterThan(s.get(U('/x'))!);
  // /y is linked only from the canonicalised page, whose links pass nothing:
  // it scores like /u, whose only link (ugc) passes nothing either.
  expect(s.get(U('/y'))!).toBeLessThan(s.get(U('/x'))!);
  expect(s.get(U('/y'))).toBe(s.get(U('/u')));
});

it('ugc and sponsored links pass no score unless nofollow links are counted (B125)', () => {
  const s = scores(false);
  expect(s.get(U('/u'))!).toBeLessThan(s.get(U('/x'))!);
  const counted = scores(false, true);
  expect(counted.get(U('/u'))).toBe(counted.get(U('/x')));
  // sponsored passes nothing either: /s scores like /u, below a followed page.
  expect(s.get(U('/s'))).toBe(s.get(U('/u')));
  expect(counted.get(U('/s'))).toBe(counted.get(U('/x')));
});

it('a page with two different canonicals passes nothing and keeps its own score (B125)', () => {
  const s = scores(true);
  expect(s.get(U('/k'))).not.toBeNull();
  expect(s.get(U('/k'))!).toBeGreaterThan(0);
});

it('with no internal links the redirect and canonicalised rows are still empty (B125)', () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b125-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code, redirect_target) VALUES
    (1, '${U('/')}', 0, 'html', 200, NULL), (2, '${U('/r')}', 0, 'html', 301, '${U('/')}');`);
  raw.close();
  const db = new ProjectDb(file);
  db.recomputeLinkScore();
  const rows = new Map([...db.iterateUrlsByCategory('all')].map((r) => [r.url, r.linkScore]));
  db.close();
  expect(rows.get(U('/r'))).toBeNull();
});
