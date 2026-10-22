import { describe, expect, it } from 'vitest';
import {
  compareServedRendered,
  parseHtml,
  readServedPageSignals,
  renderDiffJson,
} from './html-parser.js';

const PAGE = 'https://ex.com/a';
const page = (body: string, head = '') => `<html><head>${head}</head><body>${body}</body></html>`;
const cmp = (served: string, rendered: string) =>
  compareServedRendered(readServedPageSignals(served, PAGE), parseHtml(rendered, PAGE));
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('compareServedRendered (B33 step 2)', () => {
  it('H1: differs, or none <-> something, is a change; equal is not', () => {
    expect(cmp(page('<h1>Old</h1>'), page('<h1>New</h1>')).h1).toBe(true);
    expect(cmp(page('<p>x</p>'), page('<h1>New</h1>')).h1).toBe(true);
    expect(cmp(page('<h1>Old</h1>'), page('<p>x</p>')).h1).toBe(true);
    expect(cmp(page('<h1>  Same\n x </h1>'), page('<h1>Same x</h1>')).h1).toBe(false);
    expect(cmp(page('<p>x</p>'), page('<p>x</p>')).h1).toBe(false);
  });

  it('canonical: resolved URL differs, or none <-> something; a fragment alone does not count', () => {
    const c = (href: string) => `<link rel="canonical" href="${href}">`;
    expect(cmp(page('', c('/a')), page('', c('/b'))).canonical).toBe(true);
    expect(cmp(page(''), page('', c('/a'))).canonical).toBe(true);
    expect(cmp(page('', c('/a')), page('')).canonical).toBe(true);
    expect(cmp(page('', c('/a')), page('', c('https://ex.com/a'))).canonical).toBe(false);
    expect(cmp(page('', c('/a')), page('', c('/a#top'))).canonical).toBe(false);
  });

  it('links: an internal link added or removed is a change, external ones only go to the detail', () => {
    const a = (h: string) => `<a href="${h}">x</a>`;
    const base = a('/one') + a('/two');
    const added = cmp(page(base), page(base + a('/three')));
    expect(added.links).toBe(true);
    expect(added.linksAdded).toBe(1);
    expect(added.addedTargets).toEqual(['https://ex.com/three']);
    const removed = cmp(page(base), page(a('/one')));
    expect(removed.links).toBe(true);
    expect(removed.linksRemoved).toBe(1);
    const external = cmp(page(base), page(base + a('https://other.org/x')));
    expect(external.links).toBe(false);
    expect(external.externalAdded).toBe(1);
    expect(cmp(page(base), page(base)).links).toBe(false);
  });

  it('links: 6000 identical links on both sides are no change; one new link in the first 5000 is', () => {
    const a = (i: number) => `<a href="/p${i}">x</a>`;
    const same = Array.from({ length: 6000 }, (_, i) => a(i)).join('');
    const r = cmp(page(same), page(same));
    expect(r.links).toBe(false);
    expect(r.linksCapped).toBe(true);
    const withNew = a(99999) + same;
    const r2 = cmp(page(same), page(withNew));
    expect(r2.links).toBe(true);
    expect(r2.addedTargets).toContain('https://ex.com/p99999');
  });

  it('text: needs more than 20 % and at least 30 words', () => {
    expect(cmp(page(words(100)), page(words(140))).text).toBe(true);
    expect(cmp(page(words(100)), page(words(110))).text).toBe(false); // under 30 words
    expect(cmp(page(words(1000)), page(words(1100))).text).toBe(false); // 100 words but 10 %
    expect(cmp(page(words(10)), page(words(45))).text).toBe(true);
    expect(cmp(page(words(100)), page(words(60))).text).toBe(true); // fewer words counts too
    expect(cmp(page(words(100)), page(words(100))).words).toEqual({ served: 100, rendered: 100 });
  });
});

describe('renderDiffJson (B33 step 4)', () => {
  it('is null when nothing differs', () => {
    expect(renderDiffJson(cmp(page('<h1>a</h1>'), page('<h1>a</h1>')))).toBeNull();
  });

  it('carries both H1 texts, link counts and clips long values to 300 chars', () => {
    const long = 'x'.repeat(500);
    const d = JSON.parse(
      renderDiffJson(
        cmp(page('<h1>Old</h1><a href="/one">1</a>'), page(`<h1>${long}</h1><a href="/two">2</a>`)),
      )!,
    );
    expect(d.h1.served).toBe('Old');
    expect(d.h1.rendered).toHaveLength(300);
    expect(d.links).toMatchObject({ added: 1, removed: 1 });
    expect(d.links.addedTargets).toEqual(['https://ex.com/two']);
    expect(d.words.served).toBeGreaterThan(0);
  });

  it('lists at most 20 added and 20 removed targets', () => {
    const a = (p: string, i: number) => `<a href="/${p}${i}">x</a>`;
    const mk = (p: string) => Array.from({ length: 30 }, (_, i) => a(p, i)).join('');
    const d = JSON.parse(renderDiffJson(cmp(page(mk('s')), page(mk('r'))))!);
    expect(d.links.added).toBe(30);
    expect(d.links.addedTargets).toHaveLength(20);
    expect(d.links.removedTargets).toHaveLength(20);
  });
});
