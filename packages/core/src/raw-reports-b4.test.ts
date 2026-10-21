import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportLinksToCsv } from './csv-export.js';
import { exportIssuesSummary, exportLinkTargetReport } from './report-export.js';
import { runBulkExport } from './bulk-export.js';

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b4-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`
    INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability) VALUES
      (1,'https://ex.com/a',0,'html',200,'indexable'),
      (2,'https://ex.com/gone',0,'html',404,'non-indexable:client-error');
    INSERT INTO links (from_url_id, to_url, anchor, is_internal, link_position) VALUES
      (1,'https://ex.com/gone','- foo',1,'content');
  `);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const lines = (f: string): string[] => fs.readFileSync(f, 'utf8').replace(/^﻿/, '').trimEnd().split('\n');

describe('raw headers reach the link and report files (B4)', () => {
  it('links CSV: labels and guard by default, keys and raw text in keys mode', async () => {
    const a = path.join(dir, 'a.csv');
    await exportLinksToCsv(db, a, { scope: 'internal' });
    expect(lines(a)[1]).toContain("'- foo");
    const k = path.join(dir, 'k.csv');
    await exportLinksToCsv(db, k, { scope: 'internal', headers: 'keys' });
    const [head, row] = lines(k);
    expect(head).toBe('fromUrl,toUrl,toStatusCode,anchor,rel,type,target,altText,linkPosition,linkPath,linkOrigin');
    expect(row).toContain(',- foo,');
  });

  it('bulk in keys mode writes the links files with keys', async () => {
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    await runBulkExport(db, out, { headers: 'keys' });
    expect(lines(path.join(out, 'links-internal.csv'))[0]).toMatch(/^fromUrl,toUrl,/);
  });

  it('link target report: keys header in keys mode', async () => {
    const k = path.join(dir, 'r.csv');
    const res = await exportLinkTargetReport(db, k, 'error-inlinks', { headers: 'keys' });
    expect(res?.rowsWritten).toBe(1);
    expect(lines(k)[0]).toBe(
      'targetUrl,statusCode,indexability,finalUrl,finalStatusCode,finalIndexability,sourcePages,isTemplate,topPosition,sampleSourceUrl',
    );
  });

  it('issues summary: keys header in keys mode', async () => {
    const k = path.join(dir, 's.csv');
    await exportIssuesSummary(db, k, { headers: 'keys' });
    expect(lines(k)[0]).toMatch(/^check,label,group,severity,urls\b/);
  });
});
