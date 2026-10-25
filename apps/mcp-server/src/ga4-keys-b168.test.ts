import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTools } from './tools.js';

// B168: every query_ga4 row has the same keys, with or without custom fields; inside `custom`
// every chosen field is a key, null where the page has no value.
const A = 'https://ex.test/a';
const B = 'https://ex.test/b';
const ROW_KEYS = ['custom', 'ga4', 'id', 'statusCode', 'url'];

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b168m-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, status_code, content_type, indexability, content_kind, is_external) VALUES
              (1,'${A}',200,'text/html','indexable','html',0), (2,'${B}',200,'text/html','indexable','html',0);
            INSERT INTO ga4_results (url, account_id, sessions, users, pageviews, engagement_rate, avg_session_duration, fetched_at)
              VALUES ('${A}','acc',10,8,20,0.5,30,'2026-10-22T00:00:00Z');`);
  raw.close();
  db = new ProjectDb(file);
  db.setMeta('integrationSettings:ga4', JSON.stringify({ accountId: 'acc' }));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const run = (args: Record<string, unknown> = {}) =>
  buildTools()
    .find((t) => t.name === 'query_ga4')!
    .handler(args, db) as { rows: Record<string, unknown>[]; total: number };

describe('query_ga4 keys (B168)', () => {
  it('no custom fields chosen: the same five keys, custom null', () => {
    const r = run();
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
      expect(row['custom']).toBeNull();
    }
    expect(r.rows.find((x) => x['url'] === B)!['ga4']).toBeNull();
  });

  it('custom fields chosen: the same five keys, every chosen field in custom, null where a page has none', () => {
    db.setMeta(
      'ga4FetchMeta:acc',
      JSON.stringify({
        property: 'properties/1',
        customFields: [
          { field: 'customEvent:author', ok: true },
          { field: 'customEvent:word_count', ok: true },
          { field: 'customEvent:broken', ok: false },
        ],
      }),
    );
    db.storeGa4CustomValues({
      accountId: 'acc',
      property: 'properties/1',
      fetchedAt: '2026-10-22T00:00:00Z',
      fields: ['customEvent:author'],
      wipeAll: false,
      rows: [{ url: A, field: 'customEvent:author', value: 'Ann', sessions: 7 }],
    });
    const r = run();
    for (const row of r.rows) expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
    expect(r.rows.find((x) => x['url'] === A)!['custom']).toEqual({
      'customEvent:author': [{ value: 'Ann', sessions: 7 }],
      'customEvent:word_count': null,
    });
    expect(r.rows.find((x) => x['url'] === B)!['custom']).toEqual({
      'customEvent:author': null,
      'customEvent:word_count': null,
    });
  });

  it('the tool description names the row keys', () => {
    const d = buildTools().find((t) => t.name === 'query_ga4')!.description;
    for (const k of ROW_KEYS) expect(d).toContain(`\`${k}\``);
  });
});
