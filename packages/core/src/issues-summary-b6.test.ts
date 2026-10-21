import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportIssuesSummary } from './report-export.js';

let dir: string;
let db: ProjectDb;

// Page a uses 3 images without alt, page b one; pages a and b link the
// same broken target 3 times in all; page c is missing its title.
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b6-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title, images_missing_alt) VALUES
      (1,'https://ex.com/a',0,'html',200,'indexable','A',3),
      (2,'https://ex.com/b',0,'html',200,'indexable','B',1),
      (3,'https://ex.com/c',0,'html',200,'indexable',NULL,0),
      (4,'https://ex.com/gone',0,'html',404,'non-indexable:client-error','G',0);
    INSERT INTO images (id, src, is_internal, occurrences) VALUES
      (1,'https://ex.com/1.png',1,1),(2,'https://ex.com/2.png',1,1),(3,'https://ex.com/3.png',1,2);
    INSERT INTO image_usages (from_url_id, image_id, alt) VALUES (1,1,NULL),(1,2,NULL),(1,3,NULL),(2,3,NULL);
    INSERT INTO links (from_url_id, to_url, anchor, is_internal) VALUES
      (1,'https://ex.com/gone','x',1),(1,'https://ex.com/gone','y',1),(2,'https://ex.com/gone','z',1);
  `);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function summary(file: string): Map<string, Record<string, string>> {
  const [head, ...rows] = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trimEnd().split('\n');
  const cols = head!.split(',');
  return new Map(
    rows.map((r) => {
      const cells = r.split(',');
      return [cells[0]!, Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']))];
    }),
  );
}

describe('issues summary counts pages (B6)', () => {
  it('URLs = distinct pages; Items = images / targets for checks counted per item', async () => {
    const out = path.join(dir, 's.csv');
    await exportIssuesSummary(db, out);
    const s = summary(out);
    expect(s.get('issues:image-missing-alt')).toMatchObject({ URLs: '2', Items: '4' });
    expect(s.get('issues:broken-links-internal')).toMatchObject({ URLs: '2', Items: '1' });
    expect(s.get('issues:title-missing')).toMatchObject({ URLs: '1', Items: '' });
  });
});
