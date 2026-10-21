import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { datasetRows } from './dataset-export.js';

/** Size knob: broken links in the fixture (spec asks for 5,000). */
const BROKEN_LINKS = 5000;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b58-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  // 500 source pages, 4 broken targets (404, 410, 500, no-response), a mix of
  // internal and external links, so ordering has ties on status and from_url.
  raw.exec('BEGIN');
  const insUrl = raw.prepare(
    'INSERT INTO urls (id, url, status_code, indexability) VALUES (?, ?, ?, ?)',
  );
  const insLink = raw.prepare(
    'INSERT INTO links (from_url_id, to_url, anchor, is_internal) VALUES (?, ?, ?, ?)',
  );
  const pages = 500;
  for (let i = 1; i <= pages; i++) insUrl.run(i, `https://ex.com/p${i}`, 200, 'indexable');
  insUrl.run(1001, 'https://ex.com/gone404', 404, 'non-indexable:client-error');
  insUrl.run(1002, 'https://ex.com/gone410', 410, 'non-indexable:client-error');
  insUrl.run(1003, 'https://other.com/err500', 500, 'non-indexable:server-error');
  insUrl.run(1004, 'https://other.com/dead', null, 'non-indexable:no-response');
  const targets = [
    ['https://ex.com/gone404', 1],
    ['https://ex.com/gone410', 1],
    ['https://other.com/err500', 0],
    ['https://other.com/dead', 0],
  ] as const;
  for (let n = 0; n < BROKEN_LINKS; n++) {
    const [to, internal] = targets[n % targets.length]!;
    insLink.run((n % pages) + 1, to, `a${n}`, internal);
  }
  raw.exec('COMMIT');
  raw.close();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('datasetRows broken-links', () => {
  it('yields the rows and order of the paged query, without a COUNT per page', () => {
    const db = new ProjectDb(file);
    // Reference: the old LIMIT/OFFSET paging, taken straight from the query.
    const expected: unknown[] = [];
    for (let offset = 0; ; offset += 2000) {
      const { rows } = db.queryBrokenLinks({ limit: 2000, offset, internal: 'all' });
      expected.push(...rows);
      if (rows.length < 2000) break;
    }
    expect(expected).toHaveLength(BROKEN_LINKS);

    const spy = vi.spyOn(db, 'queryBrokenLinks');
    const actual = [...datasetRows(db, 'broken-links')];
    db.close();
    expect(actual).toEqual(expected);
    expect(spy).not.toHaveBeenCalled();
  });
});
