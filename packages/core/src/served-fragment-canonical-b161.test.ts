import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { compareServedRendered, parseHtml, readServedPageSignals } from './html-parser.js';

// B161: a body-less fragment whose <link rel=canonical> comes after the content. The browser keeps the
// link in the body it builds; the served read must see the same canonical, or the page would show a
// false js_canonical_changed.
const PAGE = 'https://ex.com/software/x/';
const WORDS = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
const AFTER = `<h1>Hello</h1><p>${WORDS}</p><a href="/b">b</a><link rel="canonical" href="/software/x/">`;
const MIDDLE = `<h1>Hello</h1><link rel="canonical" href="/software/x/"><p>${WORDS}</p>`;
const NONE = { h1: false, canonical: false, links: false, text: false };
const verdicts = (c: ReturnType<typeof compareServedRendered>) => ({
  h1: c.h1,
  canonical: c.canonical,
  links: c.links,
  text: c.text,
});

describe('canonical after the content of a fragment', () => {
  it.each([
    ['after', AFTER],
    ['in the middle', MIDDLE],
  ])('served read puts it in the body (%s), like the browser, so no change is reported', (_n, html) => {
    const served = readServedPageSignals(html, PAGE);
    expect(served.canonical).toBeNull();
    const rendered = parseHtml(`<html><head></head><body>${html}</body></html>`, PAGE);
    expect(verdicts(compareServedRendered(served, rendered))).toEqual(NONE);
  });

  it('a canonical before any content is still the head canonical', () => {
    const html = `<link rel="canonical" href="/software/x/"><h1>Hello</h1><p>${WORDS}</p>`;
    expect(readServedPageSignals(html, PAGE).canonical).toBe('https://ex.com/software/x/');
    const withTitle = `<title>t</title>\n<meta charset="utf-8"><link rel="canonical" href="/y/"><p>text</p>`;
    expect(readServedPageSignals(withTitle, PAGE).canonical).toBe('https://ex.com/y/');
  });

  it('a canonical a script adds to the head after a served body-less page is still a change', () => {
    const served = readServedPageSignals(AFTER, PAGE);
    const rendered = parseHtml(
      `<html><head><link rel="canonical" href="/other/"></head><body>${AFTER}</body></html>`,
      PAGE,
    );
    expect(compareServedRendered(served, rendered).canonical).toBe(true);
  });

  it('real Chromium: no canonical verdict through page.content() -> parseHtml', async () => {
    let browser;
    try {
      browser = await chromium.launch();
    } catch (err) {
      console.warn('SKIPPED: Chromium is not installed (', (err as Error).message, ')');
      return;
    }
    try {
      const page = await browser.newPage();
      for (const html of [AFTER, MIDDLE]) {
        await page.setContent(html);
        const rendered = parseHtml(await page.content(), PAGE);
        expect(verdicts(compareServedRendered(readServedPageSignals(html, PAGE), rendered))).toEqual(NONE);
      }
    } finally {
      await browser.close();
    }
  }, 60_000);
});
