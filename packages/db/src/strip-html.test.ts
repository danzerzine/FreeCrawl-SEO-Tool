import { describe, expect, it } from 'vitest';
import { stripHtml } from './strip-html.js';

/** The pre-fix implementation, kept verbatim as the oracle. */
const oldStripHtml = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(?:script|style|noscript)\b[\s\S]*$/i, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[#a-z0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const page = (body: string): string =>
  `<!doctype html><html><head><title>T</title><style>body{margin:0}</style>` +
  `<script>var a = "<b>";</script></head><body>${body}</body></html>`;

const CASES: Record<string, string> = {
  empty: '',
  plain: 'Just some text, no tags at all.',
  typical: page(
    '<nav><a href="/">Home</a> <a href="/x">About us</a></nav><h1>Title &amp; more</h1>' +
      '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>' +
      '<noscript><img src="/pixel.gif"></noscript><!-- a comment --><footer>(c) 2026</footer>',
  ),
  'several blocks': '<script>a</script>x<script>b</script>y<style>c</style>z<noscript>d</noscript>w',
  'mixed case': 'a<ScRiPt>var x</sCrIpT>b<STYLE>p{}</Style>c<NoScript>n</NOSCRIPT>d',
  'attributes on opener': 'a<script type="text/javascript" src="/x.js"></script>b<style media="all">p{}</style>c',
  'close tag with space': 'a<script>var x = 1;</script >b</script>c',
  'close tag with space only': 'before <script>var x;</script > after text',
  'unterminated script': 'prose words here <script>var big = "minified bundle";',
  'unterminated style after closed script': 'one <script>a</script> two <style>p{color:red}',
  'unterminated noscript': 'one <noscript><img src=x>',
  'second opener unterminated': 'a<script>x</script>b<script>never closed',
  nested: '<script><script>x</script>y</script>z',
  'script inside style': '<style>/* <script> */ p{}</style>text<script>k</script>tail',
  'style inside script': '<script>var s = "<style>";</script>mid<style>q{}</style>end',
  'overlapping pairs': '<style> <script> </style> </script> after',
  'script-like names': 'a<scripts>x</script>b<scriptfoo>y</scriptfoo>c</script>d',
  'closer first': '</script>a<script>b</script>c',
  'opener at the very end': 'text <script',
  'opener and closer touching': '<script></script>x<style></style>y',
  'comment holding a script': 'a<!-- <script>x</script> -->b',
  'unicode that changes length when lowercased': 'İİİ<script>x</script>Ünï<SCRIPT>y</SCRIPT>ſ<style>z</style>K',
  'non-latin text': '<p>Привет, мир</p><script>alert(1)</script><p>Ещё текст</p>',
};

describe('stripHtml: same text as the previous regex implementation', () => {
  for (const [name, html] of Object.entries(CASES)) {
    it(name, () => {
      expect(stripHtml(html)).toBe(oldStripHtml(html));
    });
  }

  it('a large realistic body gives the same text', () => {
    const para = '<p>Some <b>bold</b> prose &nbsp; with entities.</p><script>var z=1;</script>\n';
    const html = page(para.repeat(5000));
    expect(stripHtml(html)).toBe(oldStripHtml(html));
  });
});

describe('stripHtml: speed on many unclosed openers', () => {
  it('64k "<script " openers with no closing tag strip in well under 50 ms', () => {
    const html = 'intro text ' + '<script '.repeat(64_000);
    const t0 = performance.now();
    const out = stripHtml(html);
    const ms = performance.now() - t0;
    console.log(`strip-html speed: 64k unclosed <script openers (${html.length} chars) -> ${ms.toFixed(2)} ms`);
    expect(out).toBe('intro text');
    expect(ms).toBeLessThan(50);
  });

  it('the same for style and noscript openers', () => {
    for (const tag of ['style', 'noscript']) {
      const html = 'intro ' + `<${tag} `.repeat(64_000);
      const t0 = performance.now();
      const out = stripHtml(html);
      const ms = performance.now() - t0;
      console.log(`strip-html speed: 64k unclosed <${tag} openers -> ${ms.toFixed(2)} ms`);
      expect(out).toBe('intro');
      expect(ms).toBeLessThan(50);
    }
  });
});
