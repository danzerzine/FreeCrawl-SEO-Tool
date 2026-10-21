import { describe, expect, it } from 'vitest';
import { fingerprintFromShingles, minhashSimilarity, shingleHashes, tokenizeContent } from '@freecrawl/shared-types';
import { computeContentFingerprint } from './simhash.js';

/*
 * Golden values: the output of `computeContentFingerprint` before B98
 * (captured at 645e1e1). Without a template set the split pipeline must
 * reproduce them bit for bit.
 */
const words = (seed: string, n: number) => Array.from({ length: n }, (_, i) => `${seed}${i % 37} w${i}`).join(' ');
const GOLDEN: Array<[string, { simhash: string; contentHash: string; minhash: string }]> = [
  [
    words('alpha', 120),
    {
      simhash: '12ad4e11c6d36338',
      contentHash: 'b082ae05d09ea116',
      minhash:
        '0dc87e8ebe901c6581436a7f60e7e817c4450b8be44b5ac239e568e29a96a997496f26f105415d120960793b286b388e09987871528cc06cd21f77022e2effa034b89a195b9c9112707349ddc48274de071af82e9c7368fcf3494498a01ef8465e0f043461ca52103665ad4320c82c6e264dc5d8077190f472dfe451a4bc2013',
    },
  ],
  [
    'The quick brown fox jumps over the lazy dog. The quick brown fox jumps again and again! ' +
      'repeat repeat repeat '.repeat(40),
    {
      simhash: '2ba3d19c5c71edeb',
      contentHash: '635c50d5874271b9',
      minhash:
        'f49fe813eb9c8cc616dedd450c007a00692cef43f8f905cc873c09ef64cb03a1d2b97311ad7b6cc8990409b11ed741d06c368c07dd45b8a4d030d2a4e3f971232a4bc5bb6fbd091a92ff33d6da961a314b24d55223bcc80b93ce933eaaa92efd6e8b8f822251cf45551431bef35d9065ad1ec011e2a4aa13f9dc663c434ba087',
    },
  ],
  [
    'Привет мир это тест текста на русском языке, достаточно длинный для отпечатка страницы.',
    {
      simhash: '07e7cb5b441b2279',
      contentHash: '5316c886b54489cc',
      minhash:
        'd5183aef9ace52a30bfadd315e99dc7e810b9a217999dca2f6a3d8bf6d0668b948b93aef232b5099bde0762b751faddcdd1c01db7be6d6fc665810a232a9aac6c785341e85abd8d916b57e11e31ae1cc08125912f96949bb5586bebc058580a486668f749f60c0494f97d7230a550849563dea699ef6c589f46da4e82271ac47',
    },
  ],
];
const hex = (b: Uint8Array | null) => (b ? Buffer.from(b).toString('hex') : null);
const setOf = (text: string, id = 7) => ({ id, hashes: shingleHashes(tokenizeContent(text)).h32.slice().sort() });

describe('near-duplicate fingerprint split into shingle hashes + fingerprint', () => {
  it.each(GOLDEN)('no set: computeContentFingerprint and fingerprintFromShingles match the pre-B98 output (%#)', (text, want) => {
    const fp = computeContentFingerprint(text);
    expect({ simhash: fp.simhash, contentHash: fp.contentHash, minhash: hex(fp.minhash) }).toEqual(want);
    const split = fingerprintFromShingles(shingleHashes(tokenizeContent(text)));
    expect({ simhash: split.simhash, minhash: hex(split.minhash) }).toEqual({ simhash: want.simhash, minhash: want.minhash });
  });

  it('a set none of whose shingles are on the page changes nothing', () => {
    const [text, want] = GOLDEN[0]!;
    const fp = computeContentFingerprint(text, { set: setOf(words('zzz', 50)) });
    expect({ simhash: fp.simhash, contentHash: fp.contentHash, minhash: hex(fp.minhash) }).toEqual(want);
  });

  it('a set of teaser shingles makes the page match its own body, content hash and full-text SimHash unchanged', () => {
    const body = words('body', 80);
    const teaser = words('teaser', 300);
    const page = `${body} ${teaser}`;
    const plain = computeContentFingerprint(page);
    const withSet = computeContentFingerprint(page, { set: setOf(teaser) });
    const bodyOnly = computeContentFingerprint(body);
    expect(withSet.contentHash).toBe(plain.contentHash);
    expect(withSet.textSimhash).toBe(plain.simhash);
    expect(withSet.templateSetId).toBe(7);
    expect(minhashSimilarity(plain.minhash!, bodyOnly.minhash!)).toBeLessThan(0.8);
    expect(minhashSimilarity(withSet.minhash!, bodyOnly.minhash!)).toBeGreaterThan(0.95);
  });

  it('a page that is all template text gets no near-duplicate fingerprint but keeps its content hash', () => {
    const teaser = words('teaser', 300);
    const fp = computeContentFingerprint(teaser, { set: setOf(teaser) });
    expect(fp.simhash).toBeNull();
    expect(fp.minhash).toBeNull();
    expect(fp.contentHash).toBe(computeContentFingerprint(teaser).contentHash);
  });
});

describe('parseHtml with a template set (B98)', () => {
  it('fingerprints minus the set, keeps the full-text SimHash for the calendar-trap check, returns hashes on request', async () => {
    const { parseHtml } = await import('./html-parser.js');
    const teaser = words('teaser', 300);
    const html = `<html><body><main><p>${words('body', 80)}</p><aside>${teaser}</aside></main></body></html>`;
    const plain = parseHtml(html, 'https://ex.com/a');
    const withSet = parseHtml(html, 'https://ex.com/a', { templateSet: setOf(teaser), collectShingles: true });
    expect(plain.textSimhash).toBe(plain.simhash);
    expect(plain.templateSetId).toBeNull();
    expect(plain.shingles).toBeNull();
    expect(withSet.textSimhash).toBe(plain.simhash);
    expect(withSet.simhash).not.toBe(plain.simhash);
    expect(withSet.templateSetId).toBe(7);
    expect(withSet.contentHash).toBe(plain.contentHash);
    expect(withSet.shingles!.h32.length).toBeGreaterThan(300);
  });
});
