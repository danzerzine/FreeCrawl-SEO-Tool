/**
 * Charikar 64-bit SimHash for near-duplicate page detection.
 *
 * Pipeline:
 *   1. Lowercase the body text, split on word boundary, drop very short tokens.
 *   2. Build 3-shingles ("a b c") so similar paragraphs with re-ordered
 *      sentences still collide; bag-of-words is too loose for SEO content.
 *   3. Hash each shingle with FNV-1a (64-bit).
 *   4. For every bit position, accumulate `+freq` if the bit is 1 in the
 *      shingle hash, `-freq` if 0.
 *   5. Final SimHash bit = sign of the accumulator.
 *
 * Two pages within a hamming distance of ~3 over 64 bits are near-identical
 * copies. SimHash is not a similarity percentage: two posts sharing 96% of
 * their wording measured ~15 bits apart. The same shingle set therefore
 * also feeds a MinHash signature (see shared-types/minhash.ts), which is
 * what the similarity-based near-duplicate pass compares.
 *
 * Cost: ~5–10 ms on a 1 MB page (htmlparser2 already gave us trimmed text).
 * The body text itself is NOT stored in the database — only the hash.
 *
 * We deliberately use BigInt for the 64-bit math instead of pairs of 32-bit
 * numbers because Node's BigInt is fast enough at this scale (millions of
 * shingles per crawl total) and the code stays trivially correct.
 */
import {
  fingerprintFromShingles,
  fnv1a64,
  shingleHashes,
  simhashFromShingles,
  tokenizeContent,
  type ShingleHashes,
  type TemplateSet,
} from '@freecrawl/shared-types';

/** Hex helper — pads to 16 chars (64 bits) so DB rows are fixed-width. */
function toHex64(n: bigint): string {
  return n.toString(16).padStart(16, '0');
}

const SHINGLE_SIZE = 3;

/**
 * Compute the near-duplicate fingerprint (SimHash + MinHash) and the exact
 * content hash for a chunk of body text. Returns null fingerprints when
 * the page has no usable content (so the caller stores NULL in the DB and
 * the URL is excluded from clustering).
 *
 * `set`: template shingles left out of the near-duplicate fingerprint
 * (B98); the content hash and `textSimhash` (full text, read by the
 * calendar-trap detector) never skip anything. `collectShingles` returns
 * the page's shingle hashes so the fingerprint can be recomputed later
 * against a set learned after this page was parsed.
 */
export function computeContentFingerprint(
  text: string,
  opts: { set?: TemplateSet | null; collectShingles?: boolean } = {},
): {
  simhash: string | null;
  contentHash: string | null;
  minhash: Uint8Array | null;
  textSimhash: string | null;
  templateSetId: number | null;
  shingles: ShingleHashes | null;
} {
  const set = opts.set ?? null;
  const templateSetId = set ? set.id : null;
  const none = {
    simhash: null,
    contentHash: null,
    minhash: null,
    textSimhash: null,
    templateSetId,
    shingles: null,
  };
  if (!text || text.length < 50) return none;

  const tokens = tokenizeContent(text);
  if (tokens.length < SHINGLE_SIZE) return none;

  const hashes = shingleHashes(tokens);
  const { simhash, minhash } = fingerprintFromShingles(hashes, set);

  // Exact content hash — same FNV-1a but over the full token stream so
  // identical body text always collides regardless of shingle order.
  const exact = fnv1a64(tokens.join(' '));

  return {
    simhash,
    contentHash: toHex64(exact),
    minhash,
    textSimhash: set ? simhashFromShingles(hashes) : simhash,
    templateSetId,
    shingles: opts.collectShingles ? hashes : null,
  };
}

/** Hamming distance between two 64-bit hex strings. */
export function hammingDistance(aHex: string, bHex: string): number {
  if (aHex.length !== 16 || bHex.length !== 16) return 64;
  const a = BigInt('0x' + aHex);
  const b = BigInt('0x' + bHex);
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** Split a 64-bit hex SimHash into 4 16-bit bands for LSH bucketing. */
export function simhashBands(hex: string): [string, string, string, string] {
  return [hex.slice(0, 4), hex.slice(4, 8), hex.slice(8, 12), hex.slice(12, 16)];
}
