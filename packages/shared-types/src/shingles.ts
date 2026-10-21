/**
 * The near-duplicate fingerprint split in two halves so a page's shingles
 * can be hashed once and fingerprinted later against a template set:
 *
 *   shingleHashes(tokens)            distinct word 3-shingles as hashes
 *   fingerprintFromShingles(h, set?) SimHash 64 + MinHash, skipping the set
 *
 * `h32` is the FNV-1a 32 hash MinHash already uses, `h64` the FNV-1a 64
 * hash SimHash uses, `weight` SimHash's log-damped in-page frequency. A
 * template set is a sorted list of `h32` values; a shingle whose `h32` is
 * in it is left out of both signatures. Without a set the output is
 * bit-identical to the single-pass fingerprint it replaced.
 */
import { computeMinHashFromHashes, fnv1a32 } from './minhash.js';

export interface ShingleHashes {
  h32: Uint32Array;
  h64: BigUint64Array;
  weight: Uint16Array;
}

/** Shingles that repeat across many pages of a crawl, as sorted `h32` values. */
export interface TemplateSet {
  id: number;
  hashes: Uint32Array;
}

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

export function fnv1a64(input: string): bigint {
  let hash = FNV64_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV64_PRIME) & MASK64;
  }
  return hash;
}

/** FNV-1a 32 over raw bytes (template set id). */
export function fnv1a32Bytes(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const SHINGLE_SIZE = 3;
const MIN_TOKEN_LEN = 2;
/** With a set, a page needs this many shingles left to be fingerprinted. */
const MIN_SHINGLES_AFTER_SET = 3;

/**
 * Lowercase, split on non-letter/digit, drop tokens shorter than two
 * characters. Stopwords stay: for near-duplicates they are signal.
 */
export function tokenizeContent(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= MIN_TOKEN_LEN);
}

/** Distinct word 3-shingles of a token stream, hashed. */
export function shingleHashes(tokens: readonly string[]): ShingleHashes {
  const freq = new Map<string, number>();
  for (let i = 0; i <= tokens.length - SHINGLE_SIZE; i++) {
    const shingle = tokens[i] + ' ' + tokens[i + 1] + ' ' + tokens[i + 2];
    freq.set(shingle, (freq.get(shingle) ?? 0) + 1);
  }
  const n = freq.size;
  const h32 = new Uint32Array(n);
  const h64 = new BigUint64Array(n);
  const weight = new Uint16Array(n);
  let i = 0;
  for (const [shingle, f] of freq) {
    h32[i] = fnv1a32(shingle);
    h64[i] = fnv1a64(shingle);
    // Log-damped so a phrase repeated 100× doesn't drown the rest.
    weight[i] = 1 + Math.floor(Math.log2(f + 1));
    i++;
  }
  return { h32, h64, weight };
}

function inSortedSet(hashes: Uint32Array, v: number): boolean {
  let lo = 0;
  let hi = hashes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const m = hashes[mid]!;
    if (m === v) return true;
    if (m < v) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** Charikar SimHash 64 (hex) of the shingles, skipping the set's. */
export function simhashFromShingles(h: ShingleHashes, set?: TemplateSet | null): string | null {
  const v = new Int32Array(64);
  let kept = 0;
  for (let i = 0; i < h.h32.length; i++) {
    if (set && inSortedSet(set.hashes, h.h32[i]!)) continue;
    kept++;
    let x = h.h64[i]!;
    const w = h.weight[i]!;
    for (let bit = 0; bit < 64; bit++) {
      if ((x & 1n) === 1n) v[bit]! += w;
      else v[bit]! -= w;
      x >>= 1n;
    }
  }
  if (kept === 0 || (set && kept < MIN_SHINGLES_AFTER_SET)) return null;
  let sim = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (v[bit]! > 0) sim |= 1n << BigInt(bit);
  }
  return sim.toString(16).padStart(16, '0');
}

/**
 * Near-duplicate fingerprint of a page's shingles, the set's left out.
 * With a set, fewer than three shingles left → no fingerprint (the page
 * is all template text).
 */
export function fingerprintFromShingles(
  h: ShingleHashes,
  set?: TemplateSet | null,
): { simhash: string | null; minhash: Uint8Array | null } {
  const simhash = simhashFromShingles(h, set);
  if (simhash === null) return { simhash: null, minhash: null };
  const kept = set ? h.h32.filter((x) => !inSortedSet(set.hashes, x)) : h.h32;
  return { simhash, minhash: computeMinHashFromHashes(kept) };
}
