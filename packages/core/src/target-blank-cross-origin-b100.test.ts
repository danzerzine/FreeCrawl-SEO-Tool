import { describe, expect, it } from 'vitest';
import { parseHtml } from './html-parser.js';

const PAGE = 'https://example.com/page';
const count = (links: string): number =>
  parseHtml(`<html><body>${links}</body></html>`, PAGE).targetBlankNoNoopenerCount;

describe('target=_blank without noopener (B100)', () => {
  it('ignores a link to a page of the same site', () => {
    expect(count('<a href="/other" target="_blank">Other</a>')).toBe(0);
    expect(count('<a href="https://example.com/x" target="_blank">X</a>')).toBe(0);
  });

  it('counts a link to another site', () => {
    expect(count('<a href="https://other.test/x" target="_blank">X</a>')).toBe(1);
  });

  it('does not count an external link that has noopener or noreferrer', () => {
    expect(count('<a href="https://other.test/x" target="_blank" rel="noopener">X</a>')).toBe(0);
    expect(count('<a href="https://other.test/x" target="_blank" rel="noreferrer">X</a>')).toBe(0);
  });
});
