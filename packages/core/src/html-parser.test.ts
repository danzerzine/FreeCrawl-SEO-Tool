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

describe('parseHtml: structured-data rules, part 2', () => {
  const ld = (json: unknown): string =>
    `<script type="application/ld+json">${JSON.stringify(json)}</script>`;
  const findings = (...blocks: unknown[]) =>
    parseHtml(doc(blocks.map(ld).join('')), PAGE).schemaFindings;
  const required = (...blocks: unknown[]) =>
    findings(...blocks).filter((f) => f.kind === 'missing-required');
  const recommended = (...blocks: unknown[]) =>
    findings(...blocks).filter((f) => f.kind === 'missing-recommended');
  const req = (type: string, ...props: string[]) => ({
    block: 0,
    type,
    kind: 'missing-required',
    props,
  });
  const rec = (type: string, ...props: string[]) => ({
    block: 0,
    type,
    kind: 'missing-recommended',
    props,
  });

  describe('R9 conditional rows', () => {
    const recipe = { '@type': 'Recipe', name: 'Soup', image: 'https://example.com/s.jpg' };
    const event = {
      '@type': 'Event',
      name: 'Gig',
      startDate: '2026-11-01',
      location: { '@type': 'Place', address: 'Main St 1' },
    };
    const job = {
      '@type': 'JobPosting',
      title: 'Dev',
      description: 'Build',
      datePosted: '2026-10-01',
      hiringOrganization: 'Acme',
    };

    it('asks a Recipe with nutrition.calories for recipeYield', () => {
      expect(required({ ...recipe, nutrition: { calories: '200 kcal' } })).toEqual([
        req('Recipe', 'recipeYield'),
      ]);
      expect(
        required({ ...recipe, nutrition: { calories: '200 kcal' }, recipeYield: '4 servings' }),
      ).toEqual([]);
      expect(required(recipe)).toEqual([]);
    });

    it('does not fire on an empty trigger value', () => {
      expect(required({ ...recipe, nutrition: { calories: '' } })).toEqual([]);
      expect(required({ ...recipe, nutrition: {} })).toEqual([]);
      expect(required({ ...recipe, nutrition: [] })).toEqual([]);
    });

    it('asks an Event with previousStartDate for eventStatus = EventRescheduled', () => {
      const moved = { ...event, previousStartDate: '2026-10-01' };
      expect(required(moved)).toEqual([req('Event', 'eventStatus')]);
      expect(required({ ...moved, eventStatus: 'EventScheduled' })).toEqual([
        req('Event', 'eventStatus = EventRescheduled'),
      ]);
      expect(required({ ...moved, eventStatus: 'EventRescheduled' })).toEqual([]);
      expect(required({ ...moved, eventStatus: 'https://schema.org/EventRescheduled' })).toEqual(
        [],
      );
      expect(
        required({ ...moved, eventStatus: { '@id': 'https://schema.org/EventRescheduled' } }),
      ).toEqual([]);
      expect(required({ ...moved, eventStatus: ['EventScheduled', 'schema:EventRescheduled'] })).toEqual(
        [],
      );
    });

    it('compares values case-sensitively', () => {
      const moved = { ...event, previousStartDate: '2026-10-01', eventStatus: 'eventrescheduled' };
      expect(required(moved)).toEqual([req('Event', 'eventStatus = EventRescheduled')]);
    });

    it('a node without the trigger is checked exactly as before', () => {
      expect(required(event)).toEqual([]);
      expect(recommended(event)).toEqual([
        rec('Event', 'endDate', 'image', 'offers', 'organizer', 'performer', 'eventStatus', 'description'),
      ]);
    });

    it('asks a JobPosting with jobLocation for the address country', () => {
      const place = (address: unknown) => ({ ...job, jobLocation: { '@type': 'Place', address } });
      expect(required(place({ '@type': 'PostalAddress', addressLocality: 'Berlin' }))).toEqual([
        req('JobPosting', 'jobLocation.address.addressCountry'),
      ]);
      expect(required(place('Berlin, Germany'))).toEqual([
        req('JobPosting', 'jobLocation.address.addressCountry'),
      ]);
      expect(required(place({ addressCountry: 'DE' }))).toEqual([]);
    });

    it('a remote job with only applicantLocationRequirements is not asked', () => {
      expect(
        required({
          ...job,
          jobLocationType: 'TELECOMMUTE',
          applicantLocationRequirements: { '@type': 'Country', name: 'DE' },
        }),
      ).toEqual([]);
    });

    it('a reference jobLocation counts as present and as carrying the path', () => {
      expect(required({ ...job, jobLocation: { '@id': 'https://example.com/#hq' } })).toEqual([]);
    });

    it('several jobLocation values: one with a country is enough', () => {
      expect(
        required({
          ...job,
          jobLocation: [
            { '@type': 'Place', address: { addressLocality: 'Berlin' } },
            { '@type': 'Place', address: { addressCountry: 'DE' } },
          ],
        }),
      ).toEqual([]);
    });

    it('MerchantReturnPolicy: the finite window asks for merchantReturnDays (ifIs, IRI too)', () => {
      const policy = {
        '@type': 'MerchantReturnPolicy',
        applicableCountry: 'DE',
        returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
      };
      expect(required(policy)).toEqual([req('MerchantReturnPolicy', 'merchantReturnDays')]);
      expect(required({ ...policy, merchantReturnDays: 30 })).toEqual([]);
      expect(
        required({ ...policy, returnPolicyCategory: 'MerchantReturnNotPermitted' }),
      ).toEqual([]);
      expect(
        required({
          ...policy,
          returnPolicyCategory: { '@id': 'https://schema.org/MerchantReturnFiniteReturnWindow' },
        }),
      ).toEqual([req('MerchantReturnPolicy', 'merchantReturnDays')]);
    });
  });

  describe('R10 context rules with labels', () => {
    const post = {
      '@type': 'DiscussionForumPosting',
      author: { '@type': 'Person', name: 'Ann' },
      datePublished: '2026-10-01',
      text: 'Hello',
    };
    const goodComment = {
      '@type': 'Comment',
      author: { '@type': 'Person', name: 'Bob' },
      datePublished: '2026-10-02',
      text: 'Hi',
    };
    const qa = (mainEntity: unknown) => ({
      '@type': 'QAPage',
      mainEntity: {
        '@type': 'Question',
        name: 'Why?',
        answerCount: 1,
        acceptedAnswer: { '@type': 'Answer', text: 'Because' },
        ...(mainEntity as object),
      },
    });

    it('checks an untyped and a typed comment of a forum post as Comment', () => {
      expect(
        required({
          ...post,
          comment: [
            { author: { name: 'Bob' }, text: 'Hi' },
            { '@type': 'Comment', author: { name: 'Cy' }, text: 'Yo' },
          ],
        }),
      ).toEqual([
        req('Comment', 'datePublished'),
        req('Comment', 'datePublished'),
      ]);
      expect(required({ ...post, comment: goodComment })).toEqual([]);
    });

    it('checks a reply nested in a forum comment', () => {
      expect(
        required({ ...post, comment: { ...goodComment, comment: { text: 'Reply' } } }),
      ).toEqual([req('Comment', 'author', 'datePublished')]);
    });

    it('gives a comment under another parent no Comment rule', () => {
      expect(required({ '@type': 'Article', comment: { text: 'x' } })).toEqual([]);
      expect(required({ '@type': 'Article', comment: { '@type': 'Comment' } })).toEqual([]);
    });

    it('does not skip levels: a comment two steps below the post is not matched', () => {
      expect(required({ ...post, about: { comment: { '@type': 'Comment' } } })).toEqual([]);
    });

    it('a node typed differently from the expected gets no Comment rule', () => {
      const review = {
        '@type': 'Review',
        author: 'x',
        reviewRating: { '@type': 'Rating', ratingValue: 5 },
        itemReviewed: { '@type': 'Thing', name: 'T' },
      };
      expect(required({ ...post, comment: review })).toEqual([]);
    });

    it('never matches a reference, typed or not', () => {
      expect(
        required({
          ...post,
          comment: [{ '@id': 'https://example.com/#c' }, { '@id': 'https://example.com/#d', '@type': 'Comment' }],
        }),
      ).toEqual([]);
    });

    it('walks an array item by item and ignores strings in it', () => {
      expect(required({ ...post, comment: ['plain', { '@type': 'Comment', text: 'x' }] })).toEqual([
        req('Comment', 'author', 'datePublished'),
      ]);
    });

    it('checks the interaction counters of a forum post, not of a video', () => {
      expect(
        required({ ...post, interactionStatistic: { '@type': 'InteractionCounter' } }),
      ).toEqual([req('InteractionCounter', 'userInteractionCount', 'interactionType')]);
      expect(required({ ...post, interactionStatistic: { userInteractionCount: 3 } })).toEqual([
        req('InteractionCounter', 'interactionType'),
      ]);
      expect(
        required({
          '@type': 'VideoObject',
          name: 'v',
          thumbnailUrl: 'https://example.com/t.jpg',
          uploadDate: '2026-10-01',
          interactionStatistic: { '@type': 'InteractionCounter' },
        }),
      ).toEqual([]);
    });

    it('checks the answers of a Q&A page as Answer, but not those of an FAQ question', () => {
      expect(required(qa({ acceptedAnswer: { '@type': 'Answer' } }))).toEqual([
        req('Answer', 'text'),
      ]);
      expect(
        required(
          qa({ suggestedAnswer: [{ '@type': 'Answer', text: 'ok' }, { '@type': 'Answer' }] }),
        ),
      ).toEqual([req('Answer', 'text')]);
      expect(
        required({
          '@type': 'FAQPage',
          mainEntity: { '@type': 'Question', name: 'Q', acceptedAnswer: { '@type': 'Answer' } },
        }),
      ).toEqual([]);
    });

    it('checks the comments of a Q&A question and its answers as Comment needing text', () => {
      expect(required(qa({ comment: { '@type': 'Comment' } }))).toEqual([req('Comment', 'text')]);
      expect(required(qa({ comment: { author: 'x' } }))).toEqual([req('Comment', 'text')]);
      expect(required(qa({ comment: { '@type': 'Comment', text: 'ok' } }))).toEqual([]);
      expect(
        required(qa({ acceptedAnswer: { '@type': 'Answer', text: 'a', comment: { author: 'x' } } })),
      ).toEqual([req('Comment', 'text')]);
    });

    it('a Q&A question outside a QAPage gets no context rules', () => {
      expect(
        required({
          '@type': 'WebPage',
          mainEntity: { '@type': 'Question', acceptedAnswer: { '@type': 'Answer' } },
        }),
      ).toEqual([]);
    });

    it('reads an Answer in a comment slot as the Comment it is a kind of', () => {
      expect(required(qa({ comment: { '@type': 'Answer' } }))).toEqual([req('Answer', 'text')]);
    });
  });

  describe('R12 conditional applicability, and carousels (rows 8, 18, 27)', () => {
    const movie = { '@type': 'Movie', name: 'M', image: 'https://example.com/m.jpg', url: 'https://example.com/m' };
    const entry = (extra: object = {}, item: unknown = movie) => ({
      '@type': 'ListItem',
      position: 1,
      item,
      ...extra,
    });
    const list = (itemListElement: unknown) => ({ '@type': 'ItemList', itemListElement });

    it('checks the entries of an ItemList of Movies as carousel entries', () => {
      expect(required(list([entry()]))).toEqual([]);
      expect(required(list([entry({ position: undefined })]))).toEqual([req('ListItem', 'position')]);
    });

    it('asks a carousel entry for a url of its own or of its item', () => {
      const bare = { '@type': 'Movie', name: 'M', image: 'x' };
      expect(required(list([entry({}, bare)]))).toEqual([req('ListItem', 'url | item.url')]);
      expect(required(list([entry({ url: 'https://example.com/m' }, bare)]))).toEqual([]);
    });

    it('does not make a carousel of an ItemList of Products', () => {
      const product = { '@type': 'Product', name: 'P',
        image: 'https://example.com/p.jpg', offers: { '@type': 'Offer', price: 1, priceCurrency: 'EUR', availability: 'InStock' } };
      expect(required(list([entry({ position: undefined }, product)]))).toEqual([]);
      expect(findings(list([entry({ position: undefined }, product)]))).toEqual([]);
    });

    it('leaves a BreadcrumbList to the breadcrumb rules only', () => {
      expect(
        required({
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', name: 'Home', item: 'https://example.com/' },
            { '@type': 'ListItem', position: 2, name: 'Page' },
          ],
        }),
      ).toEqual([req('ListItem', 'position')]);
    });

    it('does not recognise the summary form: entries with a url only', () => {
      expect(
        required(list([{ '@type': 'ListItem', url: 'https://example.com/a' }, { '@type': 'ListItem' }])),
      ).toEqual([]);
    });

    it('takes a single entry object and a typed reference as the item', () => {
      expect(required(list(entry({ position: undefined })))).toEqual([req('ListItem', 'position')]);
      expect(
        required(
          list([entry({ position: undefined }, { '@id': 'https://example.com/#m', '@type': 'Movie' })]),
        ),
      ).toEqual([req('ListItem', 'position')]);
    });

    it('does not recognise an item given as a url string or as an untyped object', () => {
      expect(required(list([entry({ position: undefined }, 'https://example.com/m')]))).toEqual([]);
      expect(required(list([entry({ position: undefined }, { name: 'M' })]))).toEqual([]);
    });

    it('asks a carousel Movie for image and name, and a standalone Movie for nothing', () => {
      expect(required(list([entry({}, { '@type': 'Movie', name: 'M', url: 'https://example.com/m' })]))).toEqual([
        req('Movie', 'image'),
      ]);
      expect(findings({ '@type': 'Movie' })).toEqual([]);
      expect(recommended(list([entry()]))).toEqual([
        rec('Movie', 'dateCreated', 'director', 'aggregateRating', 'review'),
      ]);
    });

    it('asks a carousel Restaurant for an image next to the local business rule', () => {
      const restaurant = { '@type': 'Restaurant', name: 'R', address: 'Main St 1', url: 'https://example.com/r' };
      expect(required(list([entry({}, restaurant)]))).toEqual([req('Restaurant', 'image')]);
      expect(required(list([entry({}, { ...restaurant, image: 'https://example.com/r.jpg' })]))).toEqual([]);
      expect(required(list([entry({}, { '@type': 'Restaurant', name: 'R', url: 'https://example.com/r' })]))).toEqual([
        req('Restaurant', 'address'),
        req('Restaurant', 'image'),
      ]);
      expect(required(restaurant)).toEqual([]);
    });
  });

  describe('R11 count rule: pros and cons notes (row 6)', () => {
    const base = {
      '@type': 'Review',
      author: 'Ann',
      reviewRating: { '@type': 'Rating', ratingValue: 4 },
      itemReviewed: { '@type': 'Product', name: 'P' },
      datePublished: '2026-10-01',
    };
    const notes = (...names: unknown[]) => ({
      '@type': 'ItemList',
      itemListElement: names.map((name, i) => ({ '@type': 'ListItem', position: i + 1, name })),
    });
    const gap = req('Review', 'positiveNotes + negativeNotes: 2 or more notes');

    it('passes with one positive and one negative note', () => {
      expect(required({ ...base, positiveNotes: notes('Fast'), negativeNotes: notes('Loud') })).toEqual([]);
    });

    it('passes with two positive notes and no negative ones', () => {
      expect(required({ ...base, positiveNotes: notes('Fast', 'Light') })).toEqual([]);
    });

    it('fires with one note only', () => {
      expect(required({ ...base, positiveNotes: notes('Fast') })).toEqual([gap]);
      expect(required({ ...base, negativeNotes: notes('Loud') })).toEqual([gap]);
    });

    it('counts only notes with a name', () => {
      expect(required({ ...base, positiveNotes: notes('Fast', undefined) })).toEqual([gap]);
      expect(required({ ...base, positiveNotes: notes('Fast'), negativeNotes: notes(undefined) })).toEqual([gap]);
    });

    it('counts strings, numbers and an ItemList without entries as nothing', () => {
      expect(required({ ...base, positiveNotes: ['Fast', 'Light'] })).toEqual([gap]);
      expect(required({ ...base, positiveNotes: { '@type': 'ItemList' } })).toEqual([gap]);
      expect(
        required({ ...base, positiveNotes: { '@type': 'ItemList', itemListElement: ['Fast', 5] } }),
      ).toEqual([gap]);
    });

    it('counts a single ListItem object once', () => {
      const one = { '@type': 'ItemList', itemListElement: { '@type': 'ListItem', name: 'Fast' } };
      expect(required({ ...base, positiveNotes: one })).toEqual([gap]);
      expect(required({ ...base, positiveNotes: one, negativeNotes: one })).toEqual([]);
    });

    it('does not apply to a Review with neither property', () => {
      expect(required(base)).toEqual([]);
    });

    it('treats a reference list as met', () => {
      expect(required({ ...base, positiveNotes: { '@id': 'https://example.com/#pros' } })).toEqual([]);
      expect(
        required({ ...base, positiveNotes: { '@type': 'ItemList', itemListElement: { '@id': 'https://example.com/#x' } } }),
      ).toEqual([]);
    });

    it('is its own finding next to the Review rule', () => {
      expect(required({ ...base, author: undefined, positiveNotes: notes('Fast') })).toEqual([
        req('Review', 'author'),
        gap,
      ]);
    });

    it('checks only the review of a Product that has notes', () => {
      const product = {
        '@type': 'Product',
        name: 'P',
        review: [{ ...base, positiveNotes: notes('Fast') }, base],
      };
      expect(required(product)).toEqual([gap]);
    });
  });

  describe('row 1: SocialMediaPosting', () => {
    const social = { '@type': 'SocialMediaPosting', datePublished: '2026-10-01', text: 'Hi' };

    it('asks a SocialMediaPosting for an author with a name', () => {
      expect(required(social)).toEqual([
        req('SocialMediaPosting', 'author', 'author.name'),
      ]);
      expect(required({ ...social, author: { '@type': 'Person', name: 'Ann' } })).toEqual([]);
    });

    it('lets a posting that points to another page go without content', () => {
      const author = { '@type': 'Person', name: 'Ann' };
      const bare = { '@type': 'SocialMediaPosting', author, datePublished: '2026-10-01' };
      expect(required(bare)).toEqual([req('SocialMediaPosting', 'text | image | video')]);
      expect(required({ ...bare, url: 'https://elsewhere.example/thread' })).toEqual([]);
    });

    it('leaves a BlogPosting to the Article rule, which asks for nothing', () => {
      expect(required({ '@type': 'BlogPosting' })).toEqual([]);
      expect(required({ '@type': 'LiveBlogPosting' })).toEqual([]);
    });

    it('gives a DiscussionForumPosting its own rule only: one finding', () => {
      expect(required({ '@type': 'DiscussionForumPosting', datePublished: '2026-10-01', text: 'x' })).toEqual([
        req('DiscussionForumPosting', 'author', 'author.name'),
      ]);
    });

    it('checks the comments of a social posting like those of a forum post', () => {
      expect(
        required({ ...social, author: { name: 'Ann' }, comment: { '@type': 'Comment' } }),
      ).toEqual([req('Comment', 'author', 'datePublished', 'text | image | video')]);
    });
  });

  describe('product and merchant rows (7, 12, 13, 14)', () => {
    const offer = { '@type': 'Offer', price: '9.99', priceCurrency: 'EUR', availability: 'InStock' };
    const shipping = {
      '@type': 'OfferShippingDetails',
      deliveryTime: { '@type': 'ShippingDeliveryTime' },
      shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'DE' },
      shippingRate: { '@type': 'MonetaryAmount', value: 4.9, currency: 'EUR' },
    };

    it('asks a UnitPriceSpecification for price, and recommends priceCurrency', () => {
      expect(required({ '@type': 'UnitPriceSpecification', priceCurrency: 'EUR' })).toEqual([
        req('UnitPriceSpecification', 'price'),
      ]);
      expect(recommended({ '@type': 'UnitPriceSpecification', price: 3 })).toEqual([
        rec('UnitPriceSpecification', 'priceCurrency'),
      ]);
      expect(findings({ '@type': 'UnitPriceSpecification', price: 3, priceCurrency: 'EUR' })).toEqual([]);
    });

    it('checks OfferShippingDetails when it is there', () => {
      expect(findings(shipping)).toEqual([]);
      expect(
        required({ ...shipping, shippingRate: { '@type': 'MonetaryAmount', value: 4.9 } }),
      ).toEqual([req('OfferShippingDetails', 'shippingRate.currency')]);
      expect(
        required({ ...shipping, shippingRate: { currency: 'EUR', maxValue: 9 } }),
      ).toEqual([]);
      expect(required({ ...shipping, deliveryTime: undefined })).toEqual([
        req('OfferShippingDetails', 'deliveryTime'),
      ]);
    });

    it('does not ask a Product for shippingDetails', () => {
      expect(required({ '@type': 'Product', name: 'P', offers: offer })).toEqual([]);
    });

    it('asks a DefinedRegion for addressCountry and a ShippingService for shippingConditions', () => {
      expect(required({ '@type': 'DefinedRegion' })).toEqual([req('DefinedRegion', 'addressCountry')]);
      expect(required({ '@type': 'DefinedRegion', addressCountry: 'DE' })).toEqual([]);
      expect(required({ '@type': 'ShippingService' })).toEqual([
        req('ShippingService', 'shippingConditions'),
      ]);
    });

    it('accepts a return policy with a link instead of the country and category', () => {
      expect(
        required({ '@type': 'MerchantReturnPolicy', merchantReturnLink: 'https://example.com/returns' }),
      ).toEqual([]);
    });

    it('asks a return policy for country and category, or the link', () => {
      expect(required({ '@type': 'MerchantReturnPolicy' })).toEqual([
        req(
          'MerchantReturnPolicy',
          'applicableCountry | merchantReturnLink',
          'returnPolicyCategory | merchantReturnLink',
        ),
      ]);
    });

    it('asks for the fee amount when returns cost shipping', () => {
      const policy = {
        '@type': 'MerchantReturnPolicy',
        applicableCountry: 'DE',
        returnPolicyCategory: 'MerchantReturnUnlimitedWindow',
        returnFees: 'https://schema.org/ReturnShippingFees',
      };
      expect(required(policy)).toEqual([req('MerchantReturnPolicy', 'returnShippingFeesAmount')]);
      expect(required({ ...policy, returnShippingFeesAmount: { value: 5 } })).toEqual([]);
      expect(required({ ...policy, returnFees: 'FreeReturn' })).toEqual([]);
    });

    it('recommends an image on a Product', () => {
      const product = { '@type': 'Product', name: 'P', offers: offer };
      expect(recommended(product)).toEqual([rec('Product', 'image')]);
      expect(findings({ ...product, image: 'https://example.com/p.jpg' })).toEqual([]);
      expect(findings({ '@type': 'ProductGroup', name: 'G' })).toEqual([]);
    });
  });
  // PART2-END
});
