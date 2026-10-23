import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractPdf } from './pdf-text.js';
import { makePdf } from './pdf-fixtures.test-support.js';

// B42 / B155 text part: the text and the links inside a PDF, never throwing.
const fixture = (name: string): Uint8Array =>
  new Uint8Array(fs.readFileSync(fileURLToPath(new URL(`./fixtures/pdf/${name}`, import.meta.url))));

describe('extractPdf', () => {
  it('reads the text and the URI links of a one-page PDF', async () => {
    const r = await extractPdf(await makePdf(['Hello PDF world'], [{ page: 1, url: 'https://example.com/a' }]));
    expect(r.error).toBeUndefined();
    expect(r.pages).toBe(1);
    expect(r.text).toContain('Hello PDF world');
    expect(r.links).toEqual([{ url: 'https://example.com/a', page: 1 }]);
    expect(r.truncated).toBe(false);
  });

  it('keeps pages in order, joined by a form feed, and links with their page', async () => {
    const r = await extractPdf(
      await makePdf(
        ['First page', 'Second page', 'Third page'],
        [
          { page: 3, url: 'https://example.com/three' },
          { page: 2, url: 'https://example.com/two-a' },
          { page: 2, url: 'https://example.com/two-b' },
        ],
      ),
    );
    expect(r.pages).toBe(3);
    expect(r.text.split('\f').map((t) => t.trim())).toEqual(['First page', 'Second page', 'Third page']);
    expect(r.links).toEqual([
      { url: 'https://example.com/two-a', page: 2 },
      { url: 'https://example.com/two-b', page: 2 },
      { url: 'https://example.com/three', page: 3 },
    ]);
  });

  it('keeps Cyrillic text intact', async () => {
    const r = await extractPdf(fixture('cyrillic.pdf'));
    expect(r.error).toBeUndefined();
    expect(r.text).toContain('Привет');
  });
});

describe('extractPdf never throws', () => {
  it('corrupt bytes give an error', async () => {
    const r = await extractPdf(new TextEncoder().encode('%PDF-1.4 garbage'));
    expect(r.error).toBeTruthy();
    expect(r.text).toBe('');
    expect(r.links).toEqual([]);
  });

  it('a password-protected file gives "encrypted"', async () => {
    const r = await extractPdf(fixture('locked.pdf'));
    expect(r.error).toBe('encrypted');
  });

  it('text over the cap is cut to the cap and flagged', async () => {
    const r = await extractPdf(await makePdf(['0123456789 0123456789']), { maxChars: 8 });
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(8);
    expect(r.text).toBe('01234567');
  });

  it('pages over the cap are skipped and flagged', async () => {
    const r = await extractPdf(await makePdf(['a', 'b', 'c']), { maxPages: 2 });
    expect(r.truncated).toBe(true);
    expect(r.pages).toBe(3);
    expect(r.text.split('\f')).toHaveLength(2);
  });

  it('links over the cap are cut and flagged', async () => {
    const links = [1, 2, 3].map((n) => ({ page: 1, url: `https://example.com/${n}` }));
    const r = await extractPdf(await makePdf(['x'], links), { maxLinks: 2 });
    expect(r.truncated).toBe(true);
    expect(r.links).toHaveLength(2);
  });

  it('a file that takes longer than the time cap gives an error', async () => {
    const r = await extractPdf(await makePdf(['x']), { timeoutMs: 0 });
    expect(r.error).toMatch(/timed out/);
  });
});
