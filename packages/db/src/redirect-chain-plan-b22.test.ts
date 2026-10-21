import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb, categoryWhereClause } from './project-db.js';

/**
 * «Redirect chain» looked up, for every chain start, whether any row redirects
 * to it, with no index on redirect_target: 18 minutes per side on a
 * 261k-URL project in the B22 compare. The lookup now runs once.
 */
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rchain-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, status_code, indexability, content_kind, is_external, redirect_target, redirect_chain_length)
     VALUES (?, ?, ?, 'non-indexable:redirect', 'html', 0, ?, ?)`,
  );
  // a -> b -> c -> d: a starts the chain, b and c are middle hops.
  ins.run(1, 'https://ex.com/a', 301, 'https://ex.com/b', 3);
  ins.run(2, 'https://ex.com/b', 301, 'https://ex.com/c', 2);
  ins.run(3, 'https://ex.com/c', 301, 'https://ex.com/d', 1);
  // a two-hop chain whose start nobody redirects to, and a page without a redirect.
  ins.run(4, 'https://ex.com/x', 301, 'https://ex.com/y', 2);
  ins.run(5, 'https://ex.com/d', 200, null, 0);
  raw.close();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('redirect chain check (B22 compare speed)', () => {
  it('lists each chain once, at its first URL', () => {
    const db = new ProjectDb(file);
    const urls = [...db.iterateUrlsByCategory('issues:redirect-chain' as never)].map((r) => (r as { url: string }).url);
    const issues = db.getOverviewCounts().issues as unknown as Record<string, number>;
    db.close();
    expect(urls.sort()).toEqual(['https://ex.com/a', 'https://ex.com/x']);
    expect(issues.redirectChain).toBe(2);
  });

  it('looks up redirect targets once, not once per row', () => {
    const raw = new DatabaseSync(file);
    const clause = categoryWhereClause('issues:redirect-chain' as never);
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM urls WHERE ${clause}`).all() as { detail: string }[])
      .map((r) => r.detail)
      .join('\n');
    raw.close();
    expect(plan).not.toContain('CORRELATED');
  });
});
