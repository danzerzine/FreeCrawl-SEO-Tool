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

  it('reports a Product with no name and no review/rating/offers as missing required properties', () => {
    const p = parseHtml(doc(ld('{"@context":"https://schema.org","@type":"Product"}')), PAGE);
    expect(p.schemaInvalidCount).toBe(0);
    expect(p.schemaMissingRequired).toBe(1);
    expect(p.schemaFindings).toEqual([
      {
        block: 0,
        type: 'Product',
        kind: 'missing-required',
        props: ['name', 'review | aggregateRating | offers'],
      },
    ]);
  });

  it('no longer accepts name and image alone as a valid Product: Google wants a review, rating or offer', () => {
    const p = parseHtml(
      doc(ld('{"@type":"Product","name":"Mug","image":"https://example.com/m.jpg"}')),
      PAGE,
    );
    expect(p.schemaMissingRequired).toBe(1);
    expect(p.schemaTypes).toEqual(['Product']);
  });
});

describe('parseHtml: structured-data rules from Google\'s pages', () => {
  const ld = (json: unknown): string =>
    `<script type="application/ld+json">${JSON.stringify(json)}</script>`;
  const findings = (...blocks: unknown[]) =>
    parseHtml(doc(blocks.map(ld).join('')), PAGE).schemaFindings;
  const required = (...blocks: unknown[]) =>
    findings(...blocks).filter((f) => f.kind === 'missing-required');
  const offer = { '@type': 'Offer', price: '9.99', priceCurrency: 'EUR', availability: 'InStock' };

  it('raises no required finding on an Article: Google lists none', () => {
    expect(required({ '@type': 'Article' })).toEqual([]);
    expect(required({ '@type': 'NewsArticle', headline: 'x' })).toEqual([]);
  });

  it('checks a Restaurant and a Pharmacy as local businesses that need an address', () => {
    expect(required({ '@type': 'Restaurant', name: 'R' })).toEqual([
      { block: 0, type: 'Restaurant', kind: 'missing-required', props: ['address'] },
    ]);
    expect(required({ '@type': 'Pharmacy', name: 'P' })).toEqual([
      { block: 0, type: 'Pharmacy', kind: 'missing-required', props: ['address'] },
    ]);
  });

  it('reads a full or prefixed schema.org IRI as the type name', () => {
    for (const t of [
      'https://schema.org/Product',
      'http://schema.org/Product',
      'schema:Product',
      'https://schema.org/Product/',
    ]) {
      const f = findings({ '@type': t, name: 'Mug' });
      expect(f.filter((x) => x.kind === 'unknown-type')).toEqual([]);
      expect(f.filter((x) => x.kind === 'missing-required')).toEqual([
        { block: 0, type: 'Product', kind: 'missing-required', props: ['review | aggregateRating | offers'] },
      ]);
    }
  });

  it('checks each offer of a Product, and AggregateOffer by its own rule', () => {
    expect(required({ '@type': 'Product', name: 'Mug', offers: { '@type': 'Offer', priceCurrency: 'EUR' } })).toEqual([
      { block: 0, type: 'Offer', kind: 'missing-required', props: ['price | priceSpecification.price'] },
    ]);
    expect(
      required({ '@type': 'Product', name: 'Mug', offers: { priceSpecification: { price: 5 } } }),
    ).toEqual([]);
    expect(
      required({ '@type': 'Product', name: 'Mug', offers: { '@type': 'AggregateOffer', lowPrice: 5 } }),
    ).toEqual([{ block: 0, type: 'AggregateOffer', kind: 'missing-required', props: ['priceCurrency'] }]);
  });

  it('applies no offer rule to an Offer outside a Product', () => {
    const event = {
      '@type': 'Event',
      name: 'E',
      startDate: '2026-11-01',
      location: { '@type': 'Place', address: '1 Main St' },
      offers: { '@type': 'Offer' },
    };
    expect(required(event)).toEqual([]);
  });

  it('gives a ProductGroup its own rule, not the Product one', () => {
    expect(required({ '@type': 'ProductGroup', name: 'Coat' })).toEqual([]);
  });

  it('does not ask a nested Review for itemReviewed, but asks a standalone one', () => {
    const review = { '@type': 'Review', author: { name: 'A' }, reviewRating: { ratingValue: 4 } };
    expect(required({ '@type': 'Product', name: 'Mug', review })).toEqual([]);
    expect(required(review)).toEqual([
      { block: 0, type: 'Review', kind: 'missing-required', props: ['itemReviewed', 'itemReviewed.name'] },
    ]);
  });

  it('checks no rule on a rating given as AggregateRating inside reviewRating', () => {
    const review = {
      '@type': 'Review',
      author: { name: 'A' },
      itemReviewed: { '@type': 'Book', name: 'B' },
      reviewRating: { '@type': 'AggregateRating', ratingValue: 4 },
    };
    expect(required(review)).toEqual([]);
  });

  it('asks an AggregateRating for ratingCount or reviewCount', () => {
    expect(
      required({ '@type': 'Product', name: 'Mug', aggregateRating: { '@type': 'AggregateRating', ratingValue: 4 } }),
    ).toEqual([
      { block: 0, type: 'AggregateRating', kind: 'missing-required', props: ['ratingCount | reviewCount'] },
    ]);
  });

  it('does not ask the last breadcrumb for item, but asks the others', () => {
    const list = (items: unknown[]) => ({ '@type': 'BreadcrumbList', itemListElement: items });
    expect(
      required(
        list([
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.com/' },
          { '@type': 'ListItem', position: 2, name: 'Page' },
        ]),
      ),
    ).toEqual([]);
    expect(
      required(
        list([
          { '@type': 'ListItem', position: 1, name: 'Home' },
          { '@type': 'ListItem', position: 2, name: 'Page' },
        ]),
      ),
    ).toEqual([{ block: 0, type: 'ListItem', kind: 'missing-required', props: ['item'] }]);
  });

  it('finds the last breadcrumb by position when the list also holds a reference', () => {
    expect(
      required({
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.com/' },
          { '@type': 'ListItem', position: 2, name: 'Page' },
          { '@id': '#crumb-extra' },
        ],
      }),
    ).toEqual([]);
  });

  it('counts the review itself for the thing it rates, and checks the rest of that thing', () => {
    const review = (itemReviewed: unknown) => ({
      '@type': 'Review',
      author: { name: 'A' },
      reviewRating: { ratingValue: 4 },
      itemReviewed,
    });
    expect(required(review({ '@type': 'Product', name: 'Mug' }))).toEqual([]);
    expect(required(review({ '@type': 'Restaurant', name: 'R' }))).toEqual([
      { block: 0, type: 'Restaurant', kind: 'missing-required', props: ['address'] },
    ]);
    expect(required(review({ '@type': 'SoftwareApplication', name: 'App' }))).toEqual([
      { block: 0, type: 'SoftwareApplication', kind: 'missing-required', props: ['offers.price'] },
    ]);
    expect(required(review({ '@type': 'Recipe', name: 'Soup' }))).toEqual([
      { block: 0, type: 'Recipe', kind: 'missing-required', props: ['image'] },
    ]);
  });

  it('asks an Event for a place address, and accepts a hybrid event', () => {
    const base = { '@type': 'MusicEvent', name: 'E', startDate: '2026-11-01' };
    expect(required({ ...base, location: 'Town hall' })).toEqual([
      { block: 0, type: 'MusicEvent', kind: 'missing-required', props: ['location.address'] },
    ]);
    expect(
      required({
        ...base,
        location: [
          { '@type': 'Place', address: '1 Main St' },
          { '@type': 'VirtualLocation', url: 'https://example.com/live' },
        ],
      }),
    ).toEqual([]);
  });

  it('applies no Event rule to a BroadcastEvent', () => {
    expect(required({ '@type': 'BroadcastEvent' })).toEqual([]);
  });

  it('accepts a remote JobPosting with applicantLocationRequirements only when it says TELECOMMUTE', () => {
    const job = {
      '@type': 'JobPosting',
      title: 'Dev',
      description: 'd',
      datePosted: '2026-10-01',
      hiringOrganization: { name: 'Co' },
      applicantLocationRequirements: { '@type': 'Country', name: 'DE' },
    };
    expect(required({ ...job, jobLocationType: 'TELECOMMUTE' })).toEqual([]);
    expect(required(job)).toEqual([
      { block: 0, type: 'JobPosting', kind: 'missing-required', props: ['jobLocation'] },
    ]);
  });

  it('raises nothing on retired results and on types Google has no result for', () => {
    expect(findings({ '@type': 'FAQPage' }, { '@type': 'HowTo' }, { '@type': 'Person' })).toEqual([]);
  });

  it('still checks a Course: the course list result is live', () => {
    expect(required({ '@type': 'Course', name: 'Intro' })).toEqual([
      { block: 0, type: 'Course', kind: 'missing-required', props: ['description'] },
    ]);
  });

  it('lets an @id reference satisfy a nested path and checks no rule on the reference itself', () => {
    const graph = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', '@id': '#w', name: 'X', url: 'https://example.com/' },
        { '@type': 'WebPage', isPartOf: { '@type': 'WebSite', '@id': '#w' } },
        {
          '@type': 'Event',
          name: 'E',
          startDate: '2026-11-01',
          location: { '@id': '#venue' },
        },
      ],
    };
    expect(required(graph)).toEqual([]);
  });

  it('gives one finding for two types that resolve to the same rule', () => {
    expect(findings({ '@type': ['Article', 'NewsArticle'] })).toHaveLength(1);
  });

  it('gives a VideoGame-only node no software app rule', () => {
    expect(required({ '@type': 'VideoGame', name: 'G' })).toEqual([]);
  });

  it('checks a forum post by its own rule, and drops the content group for a post on another page', () => {
    expect(required({ '@type': 'DiscussionForumPosting', text: 't' })).toEqual([
      {
        block: 0,
        type: 'DiscussionForumPosting',
        kind: 'missing-required',
        props: ['author', 'author.name', 'datePublished'],
      },
    ]);
    const post = { '@type': 'DiscussionForumPosting', author: { name: 'A' }, datePublished: '2026-01-01' };
    expect(required({ ...post, url: 'https://example.com/t/1' })).toEqual([]);
    expect(required({ ...post, url: PAGE })).toEqual([
      { block: 0, type: 'DiscussionForumPosting', kind: 'missing-required', props: ['text | image | video'] },
    ]);
  });

  it('reads a forum post url that differs from the page only by its fragment as the page itself', () => {
    const post = { '@type': 'DiscussionForumPosting', author: { name: 'A' }, datePublished: '2026-01-01' };
    expect(required({ ...post, url: `${PAGE}#post-3` })).toEqual([
      { block: 0, type: 'DiscussionForumPosting', kind: 'missing-required', props: ['text | image | video'] },
    ]);
  });

  it('checks an offer without a type as an Offer', () => {
    expect(required({ '@type': 'Product', name: 'Mug', offers: { priceCurrency: 'EUR' } })).toEqual([
      { block: 0, type: 'Offer', kind: 'missing-required', props: ['price | priceSpecification.price'] },
    ]);
  });

  it('accepts either of the alternatives Google names for a recommended property', () => {
    const video = {
      '@type': 'VideoObject',
      name: 'V',
      thumbnailUrl: 'https://example.com/t.jpg',
      uploadDate: '2026-01-01',
      description: 'd',
      duration: 'PT1M',
      embedUrl: 'https://www.youtube.com/embed/x',
    };
    expect(findings(video)).toEqual([]);
  });

  it('does not walk @context: an "@id" coercion is not a malformed type', () => {
    expect(
      findings({ '@context': { image: { '@type': '@id' } }, '@type': 'WebPage' }).filter(
        (f) => f.kind === 'unknown-type',
      ),
    ).toEqual([]);
  });

  it('adds no finding for a complete offer to a Product that lacks only its name', () => {
    expect(
      required({ '@type': 'Product', offers: offer }).map((f) => f.props),
    ).toEqual([['name']]);
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
