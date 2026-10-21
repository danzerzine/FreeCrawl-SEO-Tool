import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MINHASH_SLOTS, shingleHashes } from '@freecrawl/shared-types';
import { ProjectDb } from './project-db.js';

/*
 * Near-duplicate clustering compares only fingerprints made with the
 * project's current template set (B98). Two identical pairs: one made with
 * the current set, one with none (NULL) while the project has a set.
 */
let dir: string;
let file: string;

const SIG = (() => {
  const out = new Uint8Array(MINHASH_SLOTS * 2);
  for (let s = 0; s < MINHASH_SLOTS; s++) out[s * 2] = s + 1;
  return out;
})();
const SIM = '00ff00ff00ff00ff';

function seed(meta: Record<string, string>, rows: Array<{ id: number; set: number | null }>): void {
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  for (const [k, v] of Object.entries(meta)) raw.prepare('INSERT INTO project_meta (key, value) VALUES (?, ?)').run(k, v);
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, simhash, minhash, template_set_id)
     VALUES (?, ?, 0, 'html', 200, 'indexable', ?, ?, ?)`,
  );
  for (const r of rows) ins.run(r.id, `https://ex.com/p${r.id}`, SIM, SIG, r.set);
  raw.close();
}
function clusterIds(): Map<number, number> {
  const raw = new DatabaseSync(file);
  const rows = raw.prepare('SELECT id, cluster_id AS c FROM urls ORDER BY id').all() as { id: number; c: number }[];
  raw.close();
  return new Map(rows.map((r) => [r.id, r.c]));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b98-'));
  file = path.join(dir, 'p.seoproject');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('clustering guard: only the current template set is compared (B98)', () => {
  it('rows made with another set get no cluster and are counted as not compared', () => {
    seed({ templateSetId: '5' }, [
      { id: 1, set: 5 },
      { id: 2, set: 5 },
      { id: 3, set: null },
      { id: 4, set: null },
    ]);
    const db = new ProjectDb(file);
    const res = db.recomputeDuplicateClusters(3, false, 90);
    const meta = db.getMeta('nearDuplicateNotCompared');
    db.close();
    const c = clusterIds();
    expect(c.get(1)).toBeGreaterThan(0);
    expect(c.get(2)).toBe(c.get(1));
    expect(c.get(3)).toBe(0);
    expect(c.get(4)).toBe(0);
    expect(res.notCompared).toBe(2);
    expect(meta).toBe('2');
  });

  it('a project without a set compares its unmarked rows as before and counts 0', () => {
    seed({}, [
      { id: 1, set: null },
      { id: 2, set: null },
    ]);
    const db = new ProjectDb(file);
    const res = db.recomputeDuplicateClusters(3, false, 90);
    const meta = db.getMeta('nearDuplicateNotCompared');
    db.close();
    expect(clusterIds().get(1)).toBeGreaterThan(0);
    expect(res.notCompared).toBe(0);
    expect(meta).toBe('0');
  });
});

describe('freezeTemplateSet and unfetched rows (B98)', () => {
  it('a held page whose write is still queued leaves its status-NULL row without fingerprint or set id', () => {
    new ProjectDb(file).close();
    const raw = new DatabaseSync(file);
    raw
      .prepare(`INSERT INTO urls (id, url, is_external, content_kind) VALUES (1, 'https://ex.com/queued', 0, 'html')`)
      .run();
    raw.close();
    const db = new ProjectDb(file);
    db.freezeTemplateSet({
      id: 7,
      hashes: Uint32Array.from([1, 2, 3]),
      sample: { pages: 1, entries: 4 },
      rows: [{ url: 'https://ex.com/queued', shingles: shingleHashes('one two three four five six seven eight'.split(' ')) }],
    });
    db.close();
    const r = new DatabaseSync(file);
    const row = r.prepare('SELECT simhash, minhash, template_set_id AS s FROM urls WHERE id = 1').get() as {
      simhash: unknown;
      minhash: unknown;
      s: number | null;
    };
    r.close();
    expect(row.simhash).toBeNull();
    expect(row.minhash).toBeNull();
    expect(row.s).toBeNull();
  });
});
