import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MINHASH_SLOTS, minhashSimilarity } from '@freecrawl/shared-types';
import { ProjectDb } from './project-db.js';

/*
 * Fixture signatures. A MinHash signature is 64 16-bit slots; `sig(seed,
 * changed)` starts from one base and gives `changed` slots a value unique to
 * `seed`. 14 changed slots ≈ 96% similar (passes 90%), 28 ≈ 90% minus (fails).
 */
let dir: string;
let file: string;

function sig(seed: number, changed: number[], base = 0): Uint8Array {
  const out = new Uint8Array(MINHASH_SLOTS * 2);
  for (let s = 0; s < MINHASH_SLOTS; s++) {
    const v = changed.includes(s) ? 1000 + seed * 64 + s : base + s + 1;
    out[s * 2] = v & 0xff;
    out[s * 2 + 1] = v >> 8;
  }
  return out;
}
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
// Chain: each step rewrites 14 more slots and keeps the earlier steps' values, so neighbours
// differ in 14 slots (pass) and pages two steps apart in 28 (fail).
function step(n: number): Uint8Array {
  const out = sig(0, []);
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
const D = step(3);
// Far SimHashes so only the MinHash test can join pages that carry a signature.
const FAR = ['0000000000000000', 'ffffffffffffffff', '00000000ffffffff', 'ffffffff00000000', '0f0f0f0f0f0f0f0f'];

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

function clusters(): Map<number, number> {
  const raw = new DatabaseSync(file);
  const rows = raw.prepare('SELECT id, cluster_id AS c FROM urls ORDER BY id').all() as { id: number; c: number }[];
  raw.close();
  return new Map(rows.map((r) => [r.id, r.c]));
}

function run(cap?: number) {
  const db = new ProjectDb(file);
  try {
    return cap === undefined ? db.recomputeDuplicateClusters(3, false, 90) : db.recomputeDuplicateClusters(3, false, 90, cap);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b64-'));
  file = path.join(dir, 'p.seoproject');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('near-duplicate clusters around a representative (B64)', () => {
  it('fixture: neighbours pass at 90%, pages two steps apart do not', () => {
    expect(minhashSimilarity(A, B)).toBeGreaterThanOrEqual(0.9);
    expect(minhashSimilarity(B, C)).toBeGreaterThanOrEqual(0.9);
    expect(minhashSimilarity(C, D)).toBeGreaterThanOrEqual(0.9);
    expect(minhashSimilarity(A, C)).toBeLessThan(0.9);
    expect(minhashSimilarity(B, D)).toBeLessThan(0.9);
  });

  it('a chain A~B~C~D never puts its ends together', () => {
    seed([
      { id: 1, simhash: FAR[0]!, minhash: A },
      { id: 2, simhash: FAR[1]!, minhash: B },
      { id: 3, simhash: FAR[2]!, minhash: C },
      { id: 4, simhash: FAR[3]!, minhash: D },
    ]);
    run();
    const c = clusters();
    // B and C have two matches each; B comes first by id and takes A and C. D matches only C, already taken.
    expect(c.get(1)).toBeGreaterThan(0);
    expect(c.get(2)).toBe(c.get(1));
    expect(c.get(3)).toBe(c.get(1));
    expect(c.get(4)).toBe(0);
  });

  it('a star: both members join the representative though they fail against each other', () => {
    seed([
      // The centre A comes second by id; it still leads, having two matches.
      { id: 1, simhash: FAR[0]!, minhash: B },
      { id: 2, simhash: FAR[1]!, minhash: A },
      { id: 3, simhash: FAR[2]!, minhash: sig(9, range(50, 64)) },
    ]);
    expect(minhashSimilarity(B, sig(9, range(50, 64)))).toBeLessThan(0.9);
    run();
    const c = clusters();
    expect(c.get(2)).toBeGreaterThan(0);
    expect(c.get(1)).toBe(c.get(2));
    expect(c.get(3)).toBe(c.get(2));
  });

  it('the canonical-conflict check reads a star cluster: every member whose canonical differs from a mate', () => {
    seed([
      { id: 1, simhash: FAR[0]!, minhash: B },
      { id: 2, simhash: FAR[1]!, minhash: A },
      { id: 3, simhash: FAR[2]!, minhash: sig(9, range(50, 64)) },
      { id: 4, simhash: FAR[3]!, minhash: D }, // not a near-duplicate of anyone here
    ]);
    const raw = new DatabaseSync(file);
    raw.exec("UPDATE urls SET canonical = url");
    raw.close();
    run();
    const db = new ProjectDb(file);
    const pages = [...db.iterateUrlsByCategory('issues:canonical-conflict-near-duplicate')].map((r) => r.url).sort();
    const count = db.getOverviewCounts().issues.canonicalConflictNearDuplicate;
    db.close();
    expect(pages).toEqual(['https://ex.com/p1', 'https://ex.com/p2', 'https://ex.com/p3']);
    expect(count).toBe(3);
  });

  it('MinHash is the only test when both pages have a signature', () => {
    seed([
      // Same SimHash, text only 89% alike: not duplicates.
      { id: 1, simhash: FAR[0]!, minhash: A },
      { id: 2, simhash: FAR[0]!, minhash: C },
      // Far SimHashes, text 96% alike: duplicates.
      { id: 3, simhash: FAR[1]!, minhash: sig(5, range(30, 44), 500) },
      { id: 4, simhash: FAR[2]!, minhash: sig(6, range(30, 44), 500) },
    ]);
    run();
    const c = clusters();
    expect(c.get(1)).toBe(0);
    expect(c.get(2)).toBe(0);
    expect(c.get(3)).toBeGreaterThan(0);
    expect(c.get(3)).toBe(c.get(4));
  });

  it('pages without a signature, and mixed pairs, use the SimHash test', () => {
    seed([
      { id: 1, simhash: '00000000000000ff', minhash: null },
      { id: 2, simhash: '00000000000000f8', minhash: null }, // 3 bits from 1: pass
      { id: 3, simhash: 'ff00000000000000', minhash: null },
      { id: 4, simhash: 'ff000000000000ff', minhash: A }, // 8 bits from 3: fail
      { id: 5, simhash: '0f0f0f0f00000000', minhash: null },
      { id: 6, simhash: '0f0f0f0f00000001', minhash: D }, // mixed, 1 bit: pass
    ]);
    run();
    const c = clusters();
    expect(c.get(1)).toBeGreaterThan(0);
    expect(c.get(2)).toBe(c.get(1));
    expect(c.get(3)).toBe(0);
    expect(c.get(4)).toBe(0);
    expect(c.get(5)).toBeGreaterThan(0);
    expect(c.get(6)).toBe(c.get(5));
  });

  it('a repeat run gives the same clusters', () => {
    seed([
      { id: 1, simhash: FAR[0]!, minhash: A },
      { id: 2, simhash: FAR[1]!, minhash: B },
      { id: 3, simhash: FAR[2]!, minhash: C },
      { id: 4, simhash: FAR[3]!, minhash: D },
      { id: 5, simhash: FAR[4]!, minhash: sig(7, range(0, 4)) },
    ]);
    run();
    const first = clusters();
    run();
    expect(clusters()).toEqual(first);
  });

  it('a bucket over the cap is reported, not dropped silently, and cleared when the next run fits', () => {
    // Four pages share band 0 (slots 0–2) and nothing else: with a cap of 3 one is left out.
    const rows = [1, 2, 3, 4].map((id) => ({
      id,
      simhash: null,
      minhash: sig(id, range(3, 64)),
    }));
    seed(rows);
    const res = run(3);
    expect(res.incomplete).toEqual({ buckets: 1, pages: 1 });
    let db = new ProjectDb(file);
    expect(JSON.parse(db.getMeta('nearDuplicateIncomplete') ?? 'null')).toEqual({ buckets: 1, pages: 1 });
    db.close();
    expect(run().incomplete).toBeNull();
    db = new ProjectDb(file);
    expect(db.getMeta('nearDuplicateIncomplete')).toBeNull();
    db.close();
  });

  it('two pages cut from a full bucket still pair up in another band they share', () => {
    // Band 0 (slots 0–2) holds all five pages; with a cap of 3 pages 4 and 5 are cut from it.
    // They share band 1 too and are 96% alike, so they must still cluster.
    seed([
      ...[1, 2, 3].map((id) => ({ id, simhash: null, minhash: sig(id, range(3, 64)) })),
      { id: 4, simhash: null, minhash: sig(40, range(50, 64)) },
      { id: 5, simhash: null, minhash: sig(50, range(50, 64)) },
    ]);
    const res = run(3);
    const c = clusters();
    expect(res.incomplete).toEqual({ buckets: 1, pages: 2 });
    expect(c.get(4)).toBeGreaterThan(0);
    expect(c.get(5)).toBe(c.get(4));
  });

  it('names clusters over 50 pages', () => {
    seed(Array.from({ length: 52 }, (_, i) => ({ id: i + 1, simhash: FAR[0]!, minhash: A })));
    const res = run();
    expect(res.clusters).toBe(1);
    expect(res.largeClusters).toEqual([{ size: 52, representative: 'https://ex.com/p1' }]);
  });

  it('near_dup_similarity is the best direct match, and the member panel sorts by MinHash similarity', () => {
    seed([
      { id: 1, simhash: FAR[0]!, minhash: A },
      // By SimHash p2 is the closer one (1 bit against 64); by text p3 is (99% against 96%).
      { id: 2, simhash: '0000000000000001', minhash: B },
      { id: 3, simhash: FAR[1]!, minhash: sig(8, range(0, 4)) },
    ]);
    run();
    const db = new ProjectDb(file);
    const members = db.urlClusterMembers(1).map((m) => m.url);
    const raw = new DatabaseSync(file);
    const sims = raw.prepare('SELECT id, near_dup_similarity AS s FROM urls ORDER BY id').all() as { id: number; s: number }[];
    raw.close();
    db.close();
    expect(members).toEqual(['https://ex.com/p3', 'https://ex.com/p2']);
    expect(sims[0]!.s).toBe(Math.round(minhashSimilarity(A, sig(8, range(0, 4))) * 100));
  });
});
