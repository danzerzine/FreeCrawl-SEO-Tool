import { describe, expect, it } from 'vitest';
import { estimatePixelWidth, parseHtml } from './html-parser.js';

// B164: `&nbsp;` must store a plain space in every field the pre-`entities` decoder handled
// (NAMED_ENTITIES.nbsp was ' ' at 1589a52), so title widths and pre/post-build compare do not move.
const URL = 'https://ex.com/';
const page = (nb: boolean) => {
  const s = nb ? '&nbsp;' : ' ';
  return (
    `<html><head><title>Tips${s}and${s}notes</title>` +
    `<meta name="description" content="Fresh${s}tips${s}daily">` +
    `<meta property="og:title" content="OG${s}title"><meta property="og:description" content="OG${s}desc">` +
    `<meta name="twitter:title" content="TW${s}title"></head>` +
    `<body><h1>Big${s}one</h1><h2>Small${s}two</h2>` +
    `<a href="/a">Read${s}more</a><img src="/i.png" alt="A${s}cat"></body></html>`
  );
};

describe('&nbsp; is a plain space in every extracted field', () => {
  const a = parseHtml(page(true), URL);
  const b = parseHtml(page(false), URL);
  it('title, description, H1, H2', () => {
    expect(a.title).toBe('Tips and notes');
    expect(a.metaDescription).toBe('Fresh tips daily');
    expect(a.h1).toBe('Big one');
    expect(a.h2First).toBe('Small two');
  });
  it('og and twitter', () => {
    expect(a.ogTitle).toBe('OG title');
    expect(a.ogDescription).toBe('OG desc');
    expect(a.twitterTitle).toBe('TW title');
  });
  it('link anchor text and image alt', () => {
    expect(a.links.find((l) => l.toUrl.endsWith('/a'))?.anchor).toBe('Read more');
    expect(a.images[0]?.alt).toBe('A cat');
  });
  it('title pixel width equals the plain-space width', () => {
    expect(estimatePixelWidth(a.title ?? '')).toBe(estimatePixelWidth('Tips and notes'));
  });
  it('stored values are identical to the plain-space page, so compare sees no change', () => {
    const pick = (r: typeof a) => ({
      title: r.title, d: r.metaDescription, h1: r.h1, h2: r.h2First, og: r.ogTitle, ogd: r.ogDescription,
      tw: r.twitterTitle, anchors: r.links.map((l) => l.anchor), alts: r.images.map((i) => i.alt),
    });
    expect(pick(a)).toEqual(pick(b));
  });
  it('numeric references to U+00A0 also give a plain space', () => {
    const r = parseHtml('<html><head><title>a&#160;b&#xA0;c</title></head></html>', URL);
    expect(r.title).toBe('a b c');
  });
});

describe('attributes use attribute decoding rules', () => {
  const meta = (c: string) =>
    parseHtml(`<html><head><meta name="description" content="${c}"><meta property="og:title" content="${c}"><meta name="twitter:title" content="${c}"></head></html>`, URL);
  it('legacy entity without semicolon before a letter stays literal', () => {
    const r = meta('Tips&notes');
    expect([r.metaDescription, r.ogTitle, r.twitterTitle]).toEqual(['Tips&notes', 'Tips&notes', 'Tips&notes']);
  });
  it('legacy entity before = stays literal', () => {
    expect(meta('a&copy=b').metaDescription).toBe('a&copy=b');
  });
  it('&amp; and semicolon-terminated entities still decode', () => {
    expect(meta('a &amp; b &notit; &not;').metaDescription).toBe('a & b &notit; ¬');
  });
  it('image alt follows attribute rules too', () => {
    const r = parseHtml('<html><body><img src="/i.png" alt="Tips&notes &amp; more"></body></html>', URL);
    expect(r.images[0]?.alt).toBe('Tips&notes & more');
  });
});
