import { describe, expect, it } from 'vitest';
import { parseHtml } from './html-parser.js';

const PAGE = 'https://ex.com/a';

const html = (body: string) => `<!doctype html><html><head><title>A</title></head><body>${body}</body></html>`;

describe('parseHtml: uncrawlable links', () => {
  it('records each uncrawlable link-like element with tag, value, target and position', () => {
    const p = parseHtml(
      html(`
        <nav><span href="/x">X</span></nav>
        <main>
          <a href="javascript:go('/y')">Y</a>
          <div onclick="location='/z'">Z</div>
          <a href="/b">B</a>
        </main>`),
      PAGE,
    );
    expect(p.uncrawlableLinks).toEqual([
      { tag: 'a', value: "javascript:go('/y')", target: 'https://ex.com/y', linkPosition: 'content', isInternal: true },
      { tag: 'span', value: '/x', target: 'https://ex.com/x', linkPosition: 'navigation', isInternal: true },
      { tag: 'div', value: "location='/z'", target: 'https://ex.com/z', linkPosition: 'content', isInternal: true },
    ]);
    expect(p.links.map((l) => l.toUrl)).toEqual(['https://ex.com/b']);
    expect(p.jsOnlyLinksCount).toBe(3);
  });

  it('derives no target from JS without a string-literal URL, and never from a non-navigating handler', () => {
    const p = parseHtml(
      html(`
        <a href="javascript:void(0)">v</a>
        <button onclick="window.open(base + id)">w</button>
        <div onclick="toggleMenu()">menu</div>
        <a href="#" onclick="openCart()">cart</a>
        <button data-href="https://other.org/p">ext</button>`),
      PAGE,
    );
    expect(p.uncrawlableLinks.map((u) => [u.tag, u.target, u.isInternal])).toEqual([
      ['a', null, true],
      ['a', null, true],
      ['button', null, true],
      ['button', 'https://other.org/p', false],
    ]);
  });

  it('truncates the raw value to 500 characters', () => {
    const long = `location.href='/q?${'a'.repeat(600)}'`;
    const p = parseHtml(html(`<div onclick="${long}">q</div>`), PAGE);
    expect(p.uncrawlableLinks[0]!.value).toHaveLength(500);
  });
});
