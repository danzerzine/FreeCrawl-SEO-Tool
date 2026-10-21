import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-nfx-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1, 'https://ex.com/', 0, 'html', 200)`);
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const link = (toUrl: string, rel: string | null) =>
  ({ toUrl, anchor: 'x', rel, isInternal: false, type: 'hyperlink', altText: null, target: null, pathType: null, linkPath: null, linkPosition: null, linkOrigin: 'html' }) as never;

function externalsAfterInsert(countNofollow: string | null, checkExternal: string | null = null): string[] {
  const db = new ProjectDb(file);
  if (countNofollow !== null) db.setMeta('countNofollowLinks', countNofollow);
  if (checkExternal !== null) db.setMeta('checkExternalLinks', checkExternal);
  db.insertLinks(1, [link('https://other.com/nf', 'nofollow'), link('https://other.com/f', null)], 0);
  db.close();
  const raw = new DatabaseSync(file);
  const urls = (raw.prepare('SELECT url FROM urls WHERE is_external = 1 ORDER BY url').all() as { url: string }[]).map((r) => r.url);
  const links = raw.prepare('SELECT COUNT(*) n FROM links').get() as { n: number };
  raw.close();
  expect(links.n).toBe(2);
  return urls;
}

it('nofollow external link is stored but gets no URL row when nofollow links are not probed', () => {
  expect(externalsAfterInsert('0')).toEqual(['https://other.com/f']);
});
it('older callers without the setting: same as default (not probed)', () => {
  expect(externalsAfterInsert(null)).toEqual(['https://other.com/f']);
});
it('Count / Probe Nofollow Links on: nofollow external gets its URL row to be probed', () => {
  expect(externalsAfterInsert('1')).toEqual(['https://other.com/f', 'https://other.com/nf']);
});
it('Check external links off: no external URL row at all (nothing will request them), links kept', () => {
  expect(externalsAfterInsert('0', '0')).toEqual([]);
});
it('Check external links off wins over Count / Probe Nofollow Links on', () => {
  expect(externalsAfterInsert('1', '0')).toEqual([]);
});
it('Check external links on: followed externals get their row as before', () => {
  expect(externalsAfterInsert('0', '1')).toEqual(['https://other.com/f']);
});
