import { describe, expect, it } from 'vitest';
import { parseHtml } from './html-parser.js';

const PAGE = 'https://example.com/page';
const doc = (body: string) => `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`;
const linksTo = (body: string) =>
  parseHtml(doc(body), PAGE).links.filter((l) => l.toUrl === 'https://example.com/t');

describe('parseHtml: duplicate target keeps the followed occurrence', () => {
  it('nofollow first, followed second: rel and anchor come from the followed one', () => {
    const l = linksTo('<a href="/t" rel="nofollow">Nav text</a><a href="/t">Body text</a>');
    expect(l).toHaveLength(1);
    expect(l[0]!.rel ?? '').not.toContain('nofollow');
    expect(l[0]!.anchor).toBe('Body text');
  });
  it('followed first, nofollow second: followed one stays', () => {
    const l = linksTo('<a href="/t">Body text</a><a href="/t" rel="nofollow">Nav text</a>');
    expect(l).toHaveLength(1);
    expect(l[0]!.rel ?? '').not.toContain('nofollow');
    expect(l[0]!.anchor).toBe('Body text');
  });
  it('empty anchor on the nofollow one does not blank the followed anchor', () => {
    const l = linksTo('<a href="/t">Body text</a><a href="/t" rel="nofollow"></a>');
    expect(l[0]!.anchor).toBe('Body text');
  });
  it('a generic anchor on the nofollow one does not replace the followed anchor', () => {
    const l = linksTo('<a href="/t">Body text</a><a href="/t" rel="nofollow">read more</a>');
    expect(l[0]!.rel ?? '').not.toContain('nofollow');
    expect(l[0]!.anchor).toBe('Body text');
  });
  it('a generic anchor on a second followed link still shows on the record', () => {
    const l = linksTo('<a href="/t">Body text</a><a href="/t">read more</a>');
    expect(l[0]!.anchor).toBe('read more');
  });
});
