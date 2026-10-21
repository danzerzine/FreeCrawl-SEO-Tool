import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPORT_DATASET_COLUMNS } from '@freecrawl/shared-types';
import { datasetRows } from './dataset-export.js';
import { exportTabular } from './tabular-export.js';
import { exportLinksToCsv } from './csv-export.js';

let dir: string;
let file: string;
let db: ProjectDb;

// Page t1 (issue) is linked from s11 (hyperlink, nofollow) and embedded as an
// image by s12; the image row t2 (also with the issue) is used by s11.
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b5-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, status_code, content_length) VALUES
      (1,'https://ex.com/t1',404,1234),(2,'https://ex.com/t2.png',200,99),
      (11,'https://ex.com/s11',200,10),(12,'https://ex.com/s12',200,10);
    INSERT INTO links (from_url_id, to_url, anchor, rel, is_internal, link_position, path_type, link_path, link_origin, target) VALUES
      (11,'https://ex.com/t1','go','nofollow',1,'content','absolute','/html/body/a','html','_blank');
    INSERT INTO images (id, src, alt, is_internal, occurrences) VALUES (7,'https://ex.com/t2.png','pic',1,1);
    INSERT INTO image_usages (from_url_id, image_id, alt) VALUES (11, 7, 'pic');
    INSERT INTO urls_issues (url_id, issue_key) VALUES (1,'issues:duplicate-url-post-norm'),(2,'issues:duplicate-url-post-norm');
  `);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const SF_LINK_HEADERS = [
  'Type', 'Source', 'Destination', 'Size', 'Alt Text', 'Anchor', 'Status Code', 'Status',
  'Follow', 'Target', 'Rel', 'Path Type', 'Link Path', 'Link Position', 'Link Origin',
  'Final Destination', 'Final Destination Status Code',
];
const headersOf = (key: keyof typeof EXPORT_DATASET_COLUMNS): string[] =>
  EXPORT_DATASET_COLUMNS[key].map((c) => c.header);

describe('one inlinks shape (B5)', () => {
  it('selected-* follow Screaming Frog bulk inlinks/outlinks columns', () => {
    expect(headersOf('selected-inlinks')).toEqual(SF_LINK_HEADERS);
    expect(headersOf('selected-outlinks')).toEqual([
      ...SF_LINK_HEADERS, 'Crawlable', 'Uncrawlable Tag', 'Uncrawlable Value',
    ]);
    expect(headersOf('issue-inlinks')).toEqual(['Issue', ...SF_LINK_HEADERS]);
  });

  it('issue-inlinks are the selected-inlinks of the issue pages, embeds included', () => {
    const issue = [...datasetRows(db, 'issue-inlinks', { issueKey: 'issues:duplicate-url-post-norm' })];
    const selected = [
      ...datasetRows(db, 'selected-inlinks', { urls: ['https://ex.com/t1', 'https://ex.com/t2.png'] }),
    ];
    expect(issue).toEqual(selected.map((r) => ({ issueKey: 'issues:duplicate-url-post-norm', ...r })));
    expect(issue.map((r) => r.type)).toEqual(['hyperlink', 'image']);
    expect(issue[0]).toMatchObject({
      fromUrl: 'https://ex.com/s11',
      toUrl: 'https://ex.com/t1',
      toSize: 1234,
      toStatusCode: 404,
      toStatus: 'Not Found',
      follow: false,
      linkPosition: 'content',
    });
    expect(issue[1]).toMatchObject({ toStatus: 'OK', follow: true, altText: 'pic' });
  });

  it('CSV of issue-inlinks writes those columns', async () => {
    const out = path.join(dir, 'i.csv');
    await exportTabular(db, out, {
      format: 'csv',
      sections: [{ label: 'X', dataset: 'issue-inlinks' }],
      columns: EXPORT_DATASET_COLUMNS['issue-inlinks'].map((c) => c.key),
      datasetContext: { issueKey: 'issues:duplicate-url-post-norm' },
    });
    const [head, first] = fs.readFileSync(out, 'utf8').replace(/^﻿/, '').split('\n');
    expect(head).toBe(['Issue', ...SF_LINK_HEADERS].join(','));
    expect(first).toBe(
      'issues:duplicate-url-post-norm,hyperlink,https://ex.com/s11,https://ex.com/t1,1234,,go,404,Not Found,false,_blank,nofollow,absolute,/html/body/a,content,html,,',
    );
  });

  it('position is «Link Position» in every export', async () => {
    const out = path.join(dir, 'l.csv');
    await exportLinksToCsv(db, out, { scope: 'internal' });
    const head = fs.readFileSync(out, 'utf8').replace(/^﻿/, '').split('\n')[0]!.split(',');
    expect(head).toContain('Link Position');
    expect(head).not.toContain('Position');
    for (const [key, cols] of Object.entries(EXPORT_DATASET_COLUMNS)) {
      for (const c of cols) {
        if (/position/i.test(c.key) && !c.key.startsWith('gsc.')) expect([key, c.header]).toEqual([key, 'Link Position']);
      }
    }
  });
});
