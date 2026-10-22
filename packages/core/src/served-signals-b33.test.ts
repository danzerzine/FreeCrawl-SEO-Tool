import { describe, expect, it } from 'vitest';
import { parseHtml, readServedPageSignals } from './html-parser.js';

const PAGE = 'https://ex.com/shop/a';

// Ten documents that exercise what an H1, a canonical, a followed link and a visible word are.
const FIXTURES: Record<string, string> = {
  plain: '<html><head><title>T</title><link rel="canonical" href="https://ex.com/shop/a"></head><body><h1>Hello</h1><p>one two three</p><a href="/b">b</a></body></html>',
  baseHref:
    '<html><head><base href="https://ex.com/"><link rel="canonical" href="shop/a/"></head><body><h1>Hi</h1><a href="products/x">x</a></body></html>',
  relativeCanonical:
    '<html><head><link rel="canonical" href="/shop/a#frag"></head><body><h1>x</h1></body></html>',
  entitiesAndSpacing:
    '<html><body><h1>  Tom &amp;\n   Jerry   <span>2</span></h1><h1>second</h1></body></html>',
  canonicalInBodyIgnored:
    '<html><head></head><body><link rel="canonical" href="https://ex.com/z"><h1>x</h1></body></html>',
  nofollowThenPlain:
    '<html><body><a rel="nofollow" href="/n">a</a><a href="/n">b</a><a rel="nofollow" href="/only-nofollow">c</a><a href="/b">d</a></body></html>',
  nonHttpAndCloudflare:
    '<html><body><a href="mailto:a@b.c">m</a><a href="javascript:void(0)">j</a><a href="#top">t</a><a href="/cdn-cgi/l/email-protection#abcd">cf</a><a href="/ok">ok</a><a href="tel:1">tel</a></body></html>',
  scriptsAndNoscript:
    '<html><body><script>var a = "many many many words here";</script><style>p{color:red}</style><noscript>hidden words</noscript><p>five visible words right here</p></body></html>',
  subdomainsAndExternal:
    '<html><body><a href="https://blog.ex.com/p">blog</a><a href="https://other.org/x">ext</a><a href="http://EX.com/UP?b=1&a=2">up</a></body></html>',
  noH1NoCanonical: '<html><head><title>only title</title></head><body><div>text</div></body></html>',
};

const followed = (html: string, includeSubdomains: boolean) =>
  parseHtml(html, PAGE, { includeSubdomains })
    .links.filter((l) => !l.rel?.includes('nofollow'))
    .map((l) => [l.toUrl, l.isInternal]);

describe('readServedPageSignals agrees with parseHtml (B33 step 1)', () => {
  for (const [name, html] of Object.entries(FIXTURES)) {
    for (const includeSubdomains of [false, true]) {
      it(`${name} (includeSubdomains ${includeSubdomains})`, () => {
        const p = parseHtml(html, PAGE, { includeSubdomains });
        const s = readServedPageSignals(html, PAGE, { includeSubdomains });
        expect(s.h1).toBe(p.h1);
        expect(s.canonical).toBe(p.canonicalResolved);
        expect(s.words).toBe(p.wordCount);
        expect(s.links).toEqual(followed(html, includeSubdomains));
        expect(s.linksCapped).toBe(false);
      });
    }
  }

  it('caps the link set at 5000 in document order and says so', () => {
    const many = Array.from({ length: 6000 }, (_, i) => `<a href="/p${i}">x</a>`).join('');
    const s = readServedPageSignals(`<html><body>${many}</body></html>`, PAGE);
    expect(s.links).toHaveLength(5000);
    expect(s.links[0]?.[0]).toBe('https://ex.com/p0');
    expect(s.links[4999]?.[0]).toBe('https://ex.com/p4999');
    expect(s.linksCapped).toBe(true);
  });
});
