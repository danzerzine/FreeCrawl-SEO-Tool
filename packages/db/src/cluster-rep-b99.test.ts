import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MINHASH_SLOTS, minhashSimilarity } from '@freecrawl/shared-types';
import { ProjectDb } from './project-db.js';

// B99: the cluster's representative is stored, and the Duplicates tab reads it.
let dir: string;
let file: string;

function sig(changed: number[], base = 0): Uint8Array {
  const out = new Uint8Array(MINHASH_SLOTS * 2);
  for (let s = 0; s < MINHASH_SLOTS; s++) {
    const v = changed.includes(s) ? 1000 + s : base + s + 1;
    out[s * 2] = v & 0xff;
    out[s * 2 + 1] = v >> 8;
  }
  return out;
}
// Chain: neighbours differ in 14 slots per step (pass at 90%), two steps apart in 28 (fail).
function step(n: number): Uint8Array {
  const out = sig([]);
  for (let s = 0; s < 14 * n; s++) {
    const v = 2000 + s;
    out[s * 2] = v & 0xff;
    out[s * 2 + 1] = v >> 8;
  }
  return out;
}
const A = step(0);
const B = step(1);
const C = step(2);
const FAR = ['0000000000000000', 'ffffffffffffffff', '00000000ffffffff'];

type Row = { id: number; simhash: string | null; minhash: Uint8Array | null };

function seed(rows: Row[]): void {
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, simhash, minhash)
     VALUES (?, ?, 0, 'html', 200, 'indexable', ?, ?)`,
  );
  for (const r of rows) ins.run(r.id, `https://ex.com/p${r.id}`, r.simhash, r.minhash);
  raw.close();
}

function recompute(): void {
  const db = new ProjectDb(file);
  db.recomputeDuplicateClusters(3, false, 90);
  db.close();
}

function listAll(opts: { readOnly?: boolean } = {}) {
  const db = new ProjectDb(file, opts);
  try {
    return db.listDuplicateClusters(0, 100);
  } finally {
    db.close();
  }
}

/* p2 (B) is the centre: it matches p1, p3 and the SimHash-only p4, so it leads;
 * p1 is the alphabetically first URL. */
const FIXTURE: Row[] = [
  { id: 1, simhash: FAR[0]!, minhash: A },
  { id: 2, simhash: FAR[1]!, minhash: B },
  { id: 3, simhash: FAR[2]!, minhash: C },
  { id: 4, simhash: 'fffffffffffffffe', minhash: null },
];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b99-'));
  file = path.join(dir, 'p.seoproject');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('cluster representative (B99)', () => {
  it('stores the representative of every member; the representative points at itself', () => {
    seed(FIXTURE);
    recompute();
    const raw = new DatabaseSync(file);
    const rows = raw.prepare('SELECT id, cluster_id AS c, cluster_rep_id AS r FROM urls ORDER BY id').all() as {
      id: number;
      c: number;
      r: number | null;
    }[];
    raw.close();
    for (const r of rows) {
      expect(r.c).toBeGreaterThan(0);
      expect(r.r).toBe(2);
    }
  });

  it('lists the stored representative, not the alphabetically first URL, with similarity to it', () => {
    seed(FIXTURE);
    recompute();
    const rows = listAll();
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.repUrlId).toBe(2);
      expect(r.repUrl).toBe('https://ex.com/p2');
    }
    const by = new Map(rows.map((r) => [r.urlId, r]));
    expect(by.get(2)!.similarityToRep).toBe(100);
    expect(by.get(2)!.hammingFromRep).toBe(0);
    expect(by.get(1)!.similarityToRep).toBe(Math.round(minhashSimilarity(A, B) * 100));
    expect(by.get(3)!.similarityToRep).toBe(Math.round(minhashSimilarity(C, B) * 100));
    // SimHash-only member: no MinHash pair, so no percentage; distance in bits instead.
    expect(by.get(4)!.similarityToRep).toBeNull();
    expect(by.get(4)!.hammingFromRep).toBe(1);
  });

  it('a page limit that cuts the cluster across two pages gives both pages the same representative', () => {
    seed(FIXTURE);
    recompute();
    const db = new ProjectDb(file);
    const first = db.listDuplicateClusters(0, 2);
    const second = db.listDuplicateClusters(2, 2);
    db.close();
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    for (const r of [...first, ...second]) expect(r.repUrl).toBe('https://ex.com/p2');
  });

  it('a cluster whose representative row was deleted keeps its members with null representative and distance', () => {
    seed(FIXTURE);
    recompute();
    const db = new ProjectDb(file);
    db.deleteUrl(2);
    const rows = db.listDuplicateClusters(0, 100);
    db.close();
    expect(rows.map((r) => r.urlId).sort()).toEqual([1, 3, 4]);
    for (const r of rows) {
      expect(r.repUrlId).toBeNull();
      expect(r.repUrl).toBeNull();
      expect(r.similarityToRep).toBeNull();
      expect(r.hammingFromRep).toBeNull();
    }
  });

  it('a project clustered by an old build (no representative stored) lists members with nulls', () => {
    seed(FIXTURE);
    recompute();
    const raw = new DatabaseSync(file);
    raw.exec('UPDATE urls SET cluster_rep_id = NULL');
    raw.close();
    const rows = listAll();
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.repUrl).toBeNull();
  });

  it('a read-only project without the column falls back to nulls instead of throwing', () => {
    seed(FIXTURE);
    recompute();
    const raw = new DatabaseSync(file);
    raw.exec('ALTER TABLE urls DROP COLUMN cluster_rep_id');
    raw.close();
    const rows = listAll({ readOnly: true });
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.repUrlId).toBeNull();
      expect(r.similarityToRep).toBeNull();
      expect(r.hammingFromRep).toBeNull();
    }
  });

  it('a re-run resets the representative of pages that left their cluster', () => {
    seed(FIXTURE);
    recompute();
    const raw = new DatabaseSync(file);
    raw.exec("UPDATE urls SET simhash = '5555555555555555', minhash = NULL WHERE id = 4");
    raw.close();
    recompute();
    const check = new DatabaseSync(file);
    const p4 = check.prepare('SELECT cluster_id AS c, cluster_rep_id AS r FROM urls WHERE id = 4').get() as {
      c: number;
      r: number | null;
    };
    check.close();
    expect(p4.c).toBe(0);
    expect(p4.r).toBeNull();
  });
});
