import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';

// B104 on the command line: `recompute-duplicates` gives the groups of a project from an older build their representative.
// Drives the built CLI as a process (`npm run build:cli` first).
const CLI = join(__dirname, '../dist/index.js');
let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'b104-cli-'));
  file = join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, simhash, cluster_id, cluster_size, cluster_rep_id)
     VALUES (?, ?, 0, 'html', 200, 'indexable', ?, ?, ?, NULL)`,
  );
  ins.run(1, 'https://ex.com/a', '0000000000000000', 1, 2);
  ins.run(2, 'https://ex.com/b', '0000000000000001', 1, 2);
  raw.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('prints the group count and stores a representative for every member', () => {
  const r = spawnSync(process.execPath, [CLI, 'recompute-duplicates', '--project', file, '--json'], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, clusters: 1, clusteredUrls: 2 });
  const db = new ProjectDb(file, { readOnly: true });
  const rows = db.listDuplicateClusters(0, 10);
  db.close();
  expect(rows).toHaveLength(2);
  expect(rows.every((x) => x.repUrl !== null)).toBe(true);
});

it('a missing project is exit 2, not a new empty one', () => {
  const r = spawnSync(process.execPath, [CLI, 'recompute-duplicates', '--project', join(dir, 'none.seoproject')], { encoding: 'utf8' });
  expect(r.status).toBe(2);
});
