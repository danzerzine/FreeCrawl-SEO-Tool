import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import type { PagespeedAuditData, PagespeedMetrics } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTools } from './tools.js';

const A = 'https://ex.test/a';
const B = 'https://ex.test/b';
const m: PagespeedMetrics = {
  performance: 80, lcp: 2000, cls: 0.1, fcp: 1000, tbt: 100, speedIndex: 1500, tti: 3000, maxPotentialFid: 90, inp: null,
  status: 'ok', error: null, fetchedAt: '2026-10-23T10:00:00.000Z',
};
const au = (id: string, over: Partial<PagespeedAuditData> = {}): PagespeedAuditData => ({
  auditId: id, kind: 'insight', title: id, score: 0, displayValue: null, savingsMs: null, savingsBytes: null, items: [], itemsTruncated: false, ...over,
});

let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b41m-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1,'${A}',0,'html',200),(2,'${B}',0,'html',200)`);
  raw.close();
  db = new ProjectDb(file);
  db.upsertPagespeedResult(A, 'mobile', m, { lighthouseVersion: '13.5.0', audits: [au('small', { savingsMs: 10 }), au('big', { savingsMs: 900, kind: 'diagnostic' }), au('mid', { savingsMs: 100 })] });
  db.upsertPagespeedResult(A, 'desktop', m, { lighthouseVersion: '13.5.0', audits: [au('small', { savingsMs: 5 })] });
  db.upsertPagespeedResult(B, 'mobile', m, { lighthouseVersion: '13.5.0', audits: [au('small', { savingsMs: 7 })] });
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Out {
  total: number;
  rows: { url: string; strategy: string; auditId: string; kind: string }[];
}
const tool = () => buildTools().find((t) => t.name === 'query_pagespeed_audits');
const run = (args: Record<string, unknown>) => tool()!.handler(args, db) as Out;

describe('B41 R9: MCP query_pagespeed_audits', () => {
  it('exists and describes its filters', () => {
    const t = tool();
    expect(t).toBeDefined();
    expect(Object.keys((t!.inputSchema as { properties: object }).properties).sort()).toEqual(['audit_id', 'kind', 'limit', 'offset', 'strategy', 'url']);
  });

  it('returns the audits biggest saving first and filters by url, strategy, kind, audit_id', () => {
    expect(run({ url: A, strategy: 'mobile' }).rows.map((r) => r.auditId)).toEqual(['big', 'mid', 'small']);
    expect(run({ kind: 'diagnostic' }).rows.map((r) => r.auditId)).toEqual(['big']);
    expect(run({ audit_id: 'small' }).rows.map((r) => `${r.url}|${r.strategy}`)).toEqual([`${A}|mobile`, `${B}|mobile`, `${A}|desktop`]);
  });

  it('pages with limit and offset, total counts all, limit is capped at 1000', () => {
    const r = run({ url: A, strategy: 'mobile', limit: 1, offset: 1 });
    expect(r.total).toBe(3);
    expect(r.rows.map((x) => x.auditId)).toEqual(['mid']);
    expect(run({ limit: 5000 }).rows).toHaveLength(5);
    const schema = (tool()!.inputSchema as { properties: { limit: { maximum: number } } }).properties;
    expect(schema.limit.maximum).toBe(1000);
  });

  it('query_pagespeed says what it stores and points to the new tool', () => {
    const d = buildTools().find((t) => t.name === 'query_pagespeed')!.description;
    expect(d).toMatch(/query_pagespeed_audits/);
    expect(d).not.toMatch(/SEO\/a11y|TTFB/);
    expect(d).toMatch(/seven/i);
  });
});
