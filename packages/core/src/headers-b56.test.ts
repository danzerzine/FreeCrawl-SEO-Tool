import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportUrlsToCsv } from './csv-export.js';
import { exportTabular } from './tabular-export.js';

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b56-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, status_code) VALUES
    (1,'https://ex.com/a',0,200),(2,'https://other.com/x',1,200);`);
  raw.close();
  db = new ProjectDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const lines = (f: string) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '').trim().split('\n');

describe('B56 headers', () => {
  it('URL CSV: human labels + Is External by default', async () => {
    const f = path.join(dir, 'a.csv');
    await exportUrlsToCsv(db, f);
    const [head, r1, r2] = lines(f);
    expect(head!.split(',').slice(0, 4)).toEqual(['URL', 'Is External', 'Status', 'Type']);
    expect(head).toContain('Meta Description 1 Length');
    expect(head).not.toContain('statusCode');
    expect(r1!.split(',').slice(0, 2)).toEqual(['https://ex.com/a', 'false']);
    expect(r2!.split(',')[1]).toBe('true');
  });

  it("URL CSV: headers 'keys' keeps machine keys", async () => {
    const f = path.join(dir, 'k.csv');
    await exportUrlsToCsv(db, f, { headers: 'keys' });
    expect(lines(f)[0]!.split(',').slice(0, 3)).toEqual(['url', 'isExternal', 'statusCode']);
  });

  it('tabular CSV and XLSX use labels; raw keeps keys', async () => {
    const f = path.join(dir, 't.csv');
    await exportTabular(db, f, {
      format: 'csv', columns: ['url', 'statusCode', 'isExternal', 'indexabilityReason'],
      sections: [{ label: 'All', category: 'all' }],
    });
    expect(lines(f)[0]).toBe('URL,Status,Is External,Indexability Status');
    await exportTabular(db, f, {
      format: 'csv', columns: ['url', 'statusCode'], headers: 'keys',
      sections: [{ label: 'All', category: 'all' }],
    });
    expect(lines(f)[0]).toBe('url,statusCode');
    const x = path.join(dir, 't.xlsx');
    await exportTabular(db, x, {
      format: 'xlsx', columns: ['url', 'statusCode'],
      sections: [{ label: 'All', category: 'all' }],
    });
    const sheet = execFileSync('unzip', ['-p', x, 'xl/worksheets/sheet1.xml']).toString();
    expect(sheet).toContain('<t>URL</t>');
    expect(sheet).toContain('<t>Status</t>');
    expect(sheet).not.toContain('statusCode');
  });

  it('dataset sections use the dataset column headers', async () => {
    const f = path.join(dir, 'd.csv');
    await exportTabular(db, f, {
      format: 'csv', columns: [],
      sections: [{ label: 'Q', dataset: 'crawl-queue', columns: ['url', 'depth'] }],
    });
    const head = lines(f)[0]!;
    expect(head).not.toBe('url,depth');
  });
});
