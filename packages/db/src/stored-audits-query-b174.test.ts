import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectDb } from './project-db.js';

// B174: queryAxe and queryPagespeedAudits filter and page the same way.
let dir: string;
let db: ProjectDb;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b174-'));
  const file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`INSERT INTO urls (id, url, is_external, content_kind, status_code) VALUES (1, 'https://ex.com/a', 0, 'html', 200), (2, 'https://ex.com/b', 0, 'html', 200)`);
  const axe = raw.prepare(`INSERT INTO axe_results (url_id, rule_id, kind, impact, help, nodes) VALUES (?, ?, 'violation', ?, 'h', ?)`);
  const ps = raw.prepare(
    `INSERT INTO pagespeed_audits (url, strategy, audit_id, kind, title, savings_ms, fetched_at) VALUES (?, 'mobile', ?, 'opportunity', 't', ?, '2026-10-01T00:00:00.000Z')`,
  );
  for (let i = 0; i < 5; i++) {
    axe.run(1 + (i % 2), `rule-${i}`, 'serious', 10 - i);
    ps.run(`https://ex.com/${i % 2 ? 'a' : 'b'}`, `audit-${i}`, 500 - i);
  }
  raw.close();
  db = new ProjectDb(file, { readOnly: true });
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('a limit below 1 or a negative offset never means "everything" or an error: both clamp the same way', () => {
  for (const [limit, offset] of [[0, 0], [-1, 0], [2, -5]] as const) {
    const a = db.queryAxe({ limit, offset });
    const p = db.queryPagespeedAudits({ limit, offset });
    expect(a.total, `axe total ${limit}/${offset}`).toBe(5);
    expect(p.total, `ps total ${limit}/${offset}`).toBe(5);
    expect(a.rows.length, `axe ${limit}/${offset}`).toBe(Math.max(1, limit));
    expect(p.rows.length, `ps ${limit}/${offset}`).toBe(Math.max(1, limit));
  }
});

it('the url filter and paging agree between the two', () => {
  expect(db.queryAxe({ url: 'https://ex.com/a', limit: 50, offset: 0 }).total).toBe(3);
  expect(db.queryPagespeedAudits({ url: 'https://ex.com/a', limit: 50, offset: 0 }).total).toBe(2);
  expect(db.queryAxe({ limit: 2, offset: 4 }).rows).toHaveLength(1);
  expect(db.queryPagespeedAudits({ limit: 2, offset: 4 }).rows).toHaveLength(1);
});
