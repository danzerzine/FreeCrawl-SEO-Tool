import { describe, expect, it } from 'vitest';
import { parseHtml } from './html-parser.js';

const PAGE = 'https://example.com/page';

function doc(head: string, body = '<p>Hello</p>'): string {
  return `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
}

describe('parseHtml: title and description', () => {
  it('keeps an emoji title whole so code-point length differs from UTF-16 length', () => {
    const p = parseHtml(doc('<title>Launch 🚀🚀 day</title>'), PAGE);
    expect(p.title).toBe('Launch 🚀🚀 day');
    // The db layer stores Array.from(title).length; each emoji must be one unit there.
    expect(Array.from(p.title ?? '').length).toBe(13);
    expect((p.title ?? '').length).toBe(15);
  });

  it('keeps a Cyrillic title and description intact', () => {
    const p = parseHtml(
      doc('<title>Привет, мир</title><meta name="description" content="Описание страницы">'),
      PAGE,
    );
    expect(p.title).toBe('Привет, мир');
    expect(Array.from(p.title ?? '').length).toBe(11);
    expect(p.metaDescription).toBe('Описание страницы');
  });

  it('collapses line breaks and double spaces in a title like a browser would', () => {
    const p = parseHtml(doc('<title>\n  Two   words\n</title>'), PAGE);
    expect(p.title).toBe('Two words');
  });

  it('counts multiple title elements but ignores titles inside inline svg', () => {
    const p = parseHtml(
      doc('<title>A</title><title>B</title>', '<svg><title>icon</title></svg>'),
      PAGE,
    );
    expect(p.titleCount).toBe(2);
  });
});

describe('parseHtml: robots meta', () => {
  it('treats noindex in a combined robots meta as non-indexable', () => {
    const p = parseHtml(doc('<meta name="robots" content="noindex,nofollow,nosnippet">'), PAGE);
    expect(p.hasNoindex).toBe(true);
    expect(p.hasNofollow).toBe(true);
  });

  it('detects noindex with uppercase directives and extra spaces', () => {
    const p = parseHtml(doc('<meta name="ROBOTS" content="  NoIndex ,  Follow ">'), PAGE);
    expect(p.hasNoindex).toBe(true);
    expect(p.hasNofollow).toBe(false);
    expect(p.metaRobots).toBe('noindex ,  follow');
  });

  it('treats robots "none" as both noindex and nofollow', () => {
    const p = parseHtml(doc('<meta name="robots" content="none">'), PAGE);
    expect(p.hasNoindex).toBe(true);
    expect(p.hasNofollow).toBe(true);
  });

  it('unions several robots metas and keeps an indexable page indexable', () => {
    const a = parseHtml(
      doc('<meta name="robots" content="index"><meta name="googlebot" content="noindex">'),
      PAGE,
    );
    expect(a.hasNoindex).toBe(true);
    const b = parseHtml(doc('<meta name="robots" content="index,follow">'), PAGE);
    expect(b.hasNoindex).toBe(false);
    expect(b.hasNofollow).toBe(false);
  });
});

describe('parseHtml: lazy-loaded images', () => {
  it('resolves a data-src image with a data: placeholder src instead of dropping it', () => {
    const p = parseHtml(
      doc(
        '',
        '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/a.jpg" loading="lazy" alt="A">',
      ),
      PAGE,
    );
    expect(p.imageCount).toBe(1);
    expect(p.images.map((i) => i.src)).toEqual(['https://example.com/img/a.jpg']);
    expect(p.imagesLazy).toBe(1);
    expect(p.imagesMissingAlt).toBe(0);
  });

  it('resolves a data-src image that has no src attribute at all', () => {
    const p = parseHtml(doc('', '<img data-src="/img/b.jpg" alt="B">'), PAGE);
    expect(p.images.map((i) => i.src)).toEqual(['https://example.com/img/b.jpg']);
    // An image whose address lives in a lazy attribute is lazy-loaded by script.
    expect(p.imagesLazy).toBe(1);
  });

  it('ignores an img with neither a usable src nor a lazy attribute', () => {
    const p = parseHtml(doc('', '<img alt="x">'), PAGE);
    expect(p.imageCount).toBe(0);
    expect(p.images).toEqual([]);
  });
});

describe('parseHtml: JS-only links', () => {
  it('counts javascript: hrefs, onclick anchors without href, and href="#" with onclick', () => {
    const p = parseHtml(
      doc(
        '',
        [
          '<a href="javascript:void(0)">a</a>',
          '<a onclick="go()">b</a>',
          '<a href="#" onclick="go()">c</a>',
        ].join(''),
      ),
      PAGE,
    );
    expect(p.jsOnlyLinksCount).toBe(3);
  });

  it('counts a non-anchor element whose onclick navigates', () => {
    const p = parseHtml(doc('', `<div onclick="location='/x'">go</div>`), PAGE);
    expect(p.jsOnlyLinksCount).toBe(1);
  });

  it('does not count in-page anchors, plain "#", or non-navigating handlers', () => {
    const p = parseHtml(
      doc(
        '',
        [
          '<a href="#">top</a>',
          '<a href="#section">jump</a>',
          '<a href="/real">real</a>',
          '<button onclick="addToCart()">buy</button>',
        ].join(''),
      ),
      PAGE,
    );
    expect(p.jsOnlyLinksCount).toBe(0);
  });
});

describe('parseHtml: hreflang placement', () => {
  const alt = '<link rel="alternate" hreflang="de" href="https://example.com/de">';

  it('reads hreflang from head', () => {
    const p = parseHtml(doc(alt), PAGE);
    expect(p.hreflangs).toHaveLength(1);
    expect(p.hreflangs[0]?.lang).toBe('de');
    expect(p.hreflangOutsideHead).toBe(0);
  });

  it('counts hreflang placed in body and does not honour it', () => {
    const p = parseHtml(doc('', alt), PAGE);
    expect(p.hreflangs).toEqual([]);
    expect(p.hreflangOutsideHead).toBe(1);
  });
});

describe('parseHtml: JSON-LD', () => {
  const ld = (json: string): string => `<script type="application/ld+json">${json}</script>`;

  it('flags invalid JSON-LD without counting it as a valid block', () => {
    const p = parseHtml(doc(ld('{"@type": "Product", name: }')), PAGE);
    expect(p.schemaInvalidCount).toBe(1);
    expect(p.schemaBlockCount).toBe(0);
  });

  it('reports a Product with no name and no image/offers as missing required properties', () => {
    const p = parseHtml(doc(ld('{"@context":"https://schema.org","@type":"Product"}')), PAGE);
    expect(p.schemaInvalidCount).toBe(0);
    expect(p.schemaMissingRequired).toBe(1);
    expect(p.schemaFindings).toEqual([
      { block: 0, type: 'Product', kind: 'missing-required', props: ['name', 'image | offers'] },
    ]);
  });

  it('accepts a Product with name and image as having its required properties', () => {
    const p = parseHtml(
      doc(ld('{"@type":"Product","name":"Mug","image":"https://example.com/m.jpg"}')),
      PAGE,
    );
    expect(p.schemaMissingRequired).toBe(0);
    expect(p.schemaTypes).toEqual(['Product']);
  });
});

describe('parseHtml: soft 404', () => {
  it('signals a thin "Page not found" page served as normal HTML', () => {
    const p = parseHtml(
      doc('<title>Page not found</title>', '<h1>Page not found</h1><p>Try the menu.</p>'),
      PAGE,
    );
    expect(p.soft404Signal).toBe(true);
  });

  it('does not signal a long article that merely mentions not-found wording', () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const p = parseHtml(
      doc('<title>Page not found errors explained</title>', `<main><p>${words}</p></main>`),
      PAGE,
    );
    expect(p.soft404Signal).toBe(false);
  });

  it('does not signal an ordinary page', () => {
    const p = parseHtml(doc('<title>Pricing</title>', '<h1>Pricing</h1>'), PAGE);
    expect(p.soft404Signal).toBe(false);
  });
});

describe('parseHtml: performance', () => {
  it('counts sentences in 200 KB of unpunctuated text in under a second (upstream #36)', () => {
    // No terminators at all: a backtracking sentence regex goes quadratic here.
    const text = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(200_000 / 27));
    const html = doc('', `<p>${text}</p>`);
    const t0 = performance.now();
    const p = parseHtml(html, PAGE);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    expect(p.sentenceCount).toBe(1);
    expect(p.wordCount).toBeGreaterThan(30_000);
  });
});
