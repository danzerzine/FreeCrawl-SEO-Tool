import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { compareServedRendered, parseHtml, readServedPageSignals } from './html-parser.js';

// B33 false positive found live (gnu.org, /software/hyperbole/): the page is an HTML fragment with no
// <html>/<body>. The browser wraps it in html/body; the served side read `$('body')` of nothing: 0 words.
const PAGE = 'https://ex.com/software/x/';
const WORDS = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
const FRAGMENT = `<h2>Title of the fragment</h2><p>${WORDS}</p><a href="/a">a</a><a href="https://other.org/o">o</a>`;

describe('readServedPageSignals on a body-less fragment', () => {
  it('counts the words of the whole document (minus head, script, style, noscript)', () => {
    const s = readServedPageSignals(FRAGMENT, PAGE);
    expect(s.words).toBe(parseHtml(`<html><body>${FRAGMENT}</body></html>`, PAGE).wordCount);
    expect(s.words).toBeGreaterThan(190);
  });
  it('leaves head text, scripts and styles out', () => {
    const s = readServedPageSignals(
      `<title>Not counted here</title><style>p{}</style><script>var a="x y z"</script><p>one two three</p>`,
      PAGE,
    );
    expect(s.words).toBe(3);
  });
  it('a page with a body is unchanged', () => {
    const s = readServedPageSignals(`<html><head><title>t t t</title></head><body><p>one two</p></body></html>`, PAGE);
    expect(s.words).toBe(2);
  });
  it('h1, canonical and links of a fragment', () => {
    const html = `<link rel="canonical" href="/software/x/"><h1>Hello &amp; bye</h1><p>text</p><a href="/b">b</a>`;
    const s = readServedPageSignals(html, PAGE);
    expect(s.h1).toBe('Hello & bye');
    expect(s.canonical).toBe('https://ex.com/software/x/');
    expect(s.links).toEqual([['https://ex.com/b', true]]);
  });
});

describe('real Chromium: a fragment page is not a rendering change', () => {
  const html = `<link rel="canonical" href="/software/x/"><h1>Hello &amp; bye</h1><p>${WORDS}</p><a href="/b">b</a><a href="https://other.org/o">o</a>`;
  it('all four verdicts 0 through page.content() -> parseHtml', async () => {
    let browser;
    try {
      browser = await chromium.launch();
    } catch (err) {
      console.warn('SKIPPED: Chromium is not installed (', (err as Error).message, ')');
      return;
    }
    try {
      const page = await browser.newPage();
      await page.setContent(html);
      const dom = await page.content();
      const rendered = parseHtml(dom, PAGE);
      const served = readServedPageSignals(html, PAGE);
      const c = compareServedRendered(served, rendered);
      expect(c.words.rendered).toBeGreaterThan(190);
      expect({ h1: c.h1, canonical: c.canonical, links: c.links, text: c.text }).toEqual({
        h1: false,
        canonical: false,
        links: false,
        text: false,
      });
    } finally {
      await browser.close();
    }
  }, 60_000);
});
