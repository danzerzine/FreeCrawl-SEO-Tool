import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { buildTools } from './tools.js';

const A = 'https://ex.test/a';
let dir: string;
let file: string;
let db: ProjectDb;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b91mcp-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, status_code, content_type, indexability) VALUES (1,'${A}',200,'text/html','indexable')`);
  raw.close();
  db = new ProjectDb(file);
  db.replaceGscResults([{ url: A, clicks: 1, impressions: 10, ctr: 0.1, position: 3 }], '2026-10-01T00:00:00Z', 'google-acc');
  db.replaceGscResults([{ url: A, clicks: 100, impressions: 1000, ctr: 0.1, position: 4 }], '2026-10-02T00:00:00Z', 'bq');
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const queryGsc = () => {
  const tool = buildTools().find((t) => t.name === 'query_gsc')!;
  const out = tool.handler({}, db) as { rows: { url: string; gsc: { clicks: number } | null }[] };
  return out.rows.find((r) => r.url === A)?.gsc?.clicks;
};

describe('MCP query_gsc reads the account of the source (B91, r1 H2)', () => {
  it('source bigquery: the bq rows, also when an API account is saved', () => {
    db.setMeta('integrationSettings:gsc', JSON.stringify({ source: 'bigquery', accountId: 'google-acc' }));
    expect(queryGsc()).toBe(100);
  });

  it('source bigquery with no OAuth account saved at all', () => {
    db.setMeta('integrationSettings:gsc', JSON.stringify({ source: 'bigquery' }));
    expect(queryGsc()).toBe(100);
  });

  it('source api: the API rows (latest pull is bq, never picked)', () => {
    db.setMeta('integrationSettings:gsc', JSON.stringify({ source: 'api' }));
    expect(queryGsc()).toBe(1);
    db.setMeta('integrationSettings:gsc', JSON.stringify({}));
    expect(queryGsc()).toBe(1);
  });
});
