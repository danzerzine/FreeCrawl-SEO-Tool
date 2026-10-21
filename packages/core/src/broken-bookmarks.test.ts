import { describe, expect, it } from 'vitest';
import { parseHtml } from './html-parser.js';

const PAGE = 'https://example.com/page';
const doc = (body: string, head = '') =>
  `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body>${body}</body></html>`;
const broken = (body: string, url = PAGE, head = '') =>
  parseHtml(doc(body, head), url).brokenBookmarkCount;

describe('parseHtml: broken same-page bookmarks', () => {
  it('flags #missing with no such id or name', () => {
    expect(broken('<a href="#missing">x</a><p id="other">y</p>')).toBe(1);
  });
  it('does not flag an existing id or <a name>', () => {
    expect(broken('<a href="#present">x</a><h2 id="present">y</h2>')).toBe(0);
    expect(broken('<a href="#present">x</a><a name="present"></a>')).toBe(0);
  });
  it('ignores #, #top, SPA hash routes and text fragments', () => {
    expect(broken('<a href="#">a</a><a href="#top">b</a><a href="#!/x">c</a><a href="#/x">d</a><a href="#:~:text=hi">e</a>')).toBe(0);
  });
  it('flags a link to the page own URL plus #missing, not to another page', () => {
    expect(broken('<a href="/page#missing">x</a>')).toBe(1);
    expect(broken('<a href="/other#missing">x</a>')).toBe(0);
  });
  it('matches ids case-sensitively and percent-decoded', () => {
    expect(broken('<a href="#Foo">x</a><p id="foo"></p>')).toBe(1);
    expect(broken('<a href="#a%20b">x</a><p id="a b"></p>')).toBe(0);
  });
  it('under <base> a bare #x points at the base page, not this one', () => {
    expect(broken('<a href="#missing">x</a>', PAGE, '<base href="https://example.com/elsewhere">')).toBe(0);
  });
  it('is not judged on a hash-routed page URL', () => {
    expect(broken('<a href="#missing">x</a>', 'https://example.com/#/about')).toBe(0);
  });
});
