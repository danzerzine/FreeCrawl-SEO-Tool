import { describe, expect, it } from 'vitest';
import { LATER_CHECKS } from '@freecrawl/db';
import { parseHtml } from './html-parser.js';

/* The same markup around the same number of letters, Russian or English. */
const page = (text: string, pad = 0) =>
  `<html><head><title>t</title></head><body><div class="${'x'.repeat(pad)}"><p>${text}</p></div></body></html>`;
const ratio = (html: string) => parseHtml(html, 'https://ex.com/a').textCodeRatio;

describe('text ratio in characters (B126)', () => {
  it('a Russian text and an English text of the same length get the same ratio', () => {
    const ru = 'Привет мир, это проверка доли текста на странице';
    const en = 'Hello world, this is a check of the text shares!';
    expect(ru.length).toBe(en.length);
    expect(ratio(page(ru))).toBe(ratio(page(en)));
  });

  it('a Russian page under 10% by characters is low even though its bytes were over 10%', () => {
    const ru = 'а'.repeat(60);
    const html = page(ru, 600 - page('').length);
    expect(Buffer.byteLength(ru) / Buffer.byteLength(html)).toBeGreaterThan(0.1);
    expect(ratio(html)).toBeLessThan(10);
  });

  it('crawls before this build are not compared on the low-ratio check', () => {
    expect(LATER_CHECKS).toContain('issues:text-code-ratio-low');
  });
});
