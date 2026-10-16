/**
 * MinHash signatures for near-duplicate *similarity* — "these two posts
 * are 96% the same text" — which SimHash can't express: SimHash with a
 * Hamming cut-off of a few bits only catches near-identical copies, and
 * two posts sharing 96% of their wording landed 15 bits apart.
 *
 * Signature: MINHASH_SLOTS independent min-hashes over the page's set of
 * word 3-shingles, each stored as its low 16 bits (b-bit MinHash). Two
 * signatures agree in a slot with probability ≈ the Jaccard similarity of
 * the shingle sets, so the share of agreeing slots estimates it. 128 bytes
 * per page.
 *
 * Jaccard over 3-shingles is a harsh scale for humans — changing one word
 * in 25 removes three shingles per change and drops it to ~0.76 — so the
 * estimate is mapped back to the word-level similarity a reader means:
 * with a fraction p of words changed independently, the shared share of
 * shingles is (1-p)^3 and J = (1-p)^3 / (2 - (1-p)^3), hence
 * similarity = (2J / (1 + J))^(1/3).
 */

export const MINHASH_SLOTS = 64;
/** Rows per LSH band; 21 bands × 3 rows use 63 of the 64 slots. */
export const MINHASH_BAND_ROWS = 3;
export const MINHASH_BANDS = Math.floor(MINHASH_SLOTS / MINHASH_BAND_ROWS);
/** Shingle length the similarity mapping assumes. */
const SHINGLE_WORDS = 3;

/** Fixed per-slot seeds (splitmix32 sequence) — signatures must be stable across runs. */
const SEEDS: Uint32Array = (() => {
  const out = new Uint32Array(MINHASH_SLOTS);
  let x = 0x9e3779b9;
  for (let i = 0; i < MINHASH_SLOTS; i++) {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    out[i] = (z ^ (z >>> 16)) >>> 0;
  }
  return out;
})();

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3 finaliser — a cheap, well-mixed 32-bit permutation. */
function mix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Signature of a set of shingles, or null when the set is empty. */
export function computeMinHash(shingles: Iterable<string>): Uint8Array | null {
  const mins = new Uint32Array(MINHASH_SLOTS).fill(0xffffffff);
  let any = false;
  for (const sh of shingles) {
    any = true;
    const base = fnv1a32(sh);
    for (let i = 0; i < MINHASH_SLOTS; i++) {
      const v = mix32(base ^ SEEDS[i]!);
      if (v < mins[i]!) mins[i] = v;
    }
  }
  if (!any) return null;
  const out = new Uint8Array(MINHASH_SLOTS * 2);
  for (let i = 0; i < MINHASH_SLOTS; i++) {
    out[i * 2] = mins[i]! & 0xff;
    out[i * 2 + 1] = (mins[i]! >>> 8) & 0xff;
  }
  return out;
}

/** 16-bit value of one slot. */
export function minhashSlot(sig: Uint8Array, slot: number): number {
  return sig[slot * 2]! | (sig[slot * 2 + 1]! << 8);
}

/** Estimated Jaccard similarity of the two shingle sets (0–1). */
export function minhashJaccard(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== MINHASH_SLOTS * 2 || b.length !== MINHASH_SLOTS * 2) return 0;
  let equal = 0;
  for (let i = 0; i < a.length; i += 2) {
    if (a[i] === b[i] && a[i + 1] === b[i + 1]) equal++;
  }
  return equal / MINHASH_SLOTS;
}

/** Estimated word-level text similarity (0–1) — see the module comment. */
export function minhashSimilarity(a: Uint8Array, b: Uint8Array): number {
  const j = minhashJaccard(a, b);
  if (j <= 0) return 0;
  return Math.pow((2 * j) / (1 + j), 1 / SHINGLE_WORDS);
}
