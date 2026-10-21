import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

let dir: string;
let file: string;

// A project stored before network failures had their own state: they sit
// in client-error with no status. Size-cap rows have a status; SSRF-guard
// skips were never requested.
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b70m-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, is_external, content_kind, status_code, status_text, indexability) VALUES
      (1, 'https://ex.com/', 0, 'html', 200, NULL, 'indexable'),
      (2, 'https://ex.com/timeout', 0, 'other', NULL, 'ETIMEDOUT', 'non-indexable:client-error'),
      (3, 'https://dead.example/', 1, 'other', NULL, 'ENOTFOUND dead.example', 'non-indexable:client-error'),
      (4, 'https://ex.com/huge', 0, 'other', 200, 'size-cap-exceeded', 'non-indexable:client-error'),
      (5, 'https://ex.com/404', 0, 'html', 404, 'Not Found', 'non-indexable:client-error'),
      (6, 'http://10.0.0.1/', 1, 'other', NULL, 'Skipped: private/internal address (SSRF guard)', 'non-indexable:client-error');
    INSERT INTO links (from_url_id, to_url, is_internal) VALUES
      (1, 'https://ex.com/timeout', 1), (1, 'https://dead.example/', 0),
      (1, 'https://ex.com/huge', 1), (1, 'https://ex.com/404', 1), (1, 'http://10.0.0.1/', 0);
    DELETE FROM schema_version WHERE version >= 104;
  `);
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('reopening an old project moves stored network failures to no response', () => {
  const db = new ProjectDb(file);
  const idx = (u: string) => db.getUrlById(db.getUrlIdByUrl(u)!)!.indexability;
  const broken = db
    .queryBrokenLinks({ limit: 50, offset: 0 })
    .rows.map((r) => r.toUrl)
    .sort();
  const result = {
    timeout: idx('https://ex.com/timeout'),
    dead: idx('https://dead.example/'),
    huge: idx('https://ex.com/huge'),
    notFound: idx('https://ex.com/404'),
    ssrf: idx('http://10.0.0.1/'),
  };
  db.close();
  expect(result).toEqual({
    timeout: 'non-indexable:no-response',
    dead: 'non-indexable:no-response',
    huge: 'non-indexable:client-error',
    notFound: 'non-indexable:client-error',
    ssrf: 'non-indexable:client-error',
  });
  expect(broken).toEqual(['https://dead.example/', 'https://ex.com/404', 'https://ex.com/timeout']);
});
