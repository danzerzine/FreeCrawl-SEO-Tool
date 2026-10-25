import { describe, expect, it } from 'vitest';
import { parseHtml } from './html-parser.js';

const PAGE = 'https://ex.com/news/1';
const positions = (body: string): Record<string, string> =>
  Object.fromEntries(
    parseHtml(`<html><head><title>T</title></head><body>${body}</body></html>`, PAGE).links.map((l) => [
      new URL(l.toUrl).pathname,
      l.linkPosition,
    ]),
  );

describe('link position (B170)', () => {
  it('a link in the article text is content; a sidebar link without a nav ancestor is not', () => {
    const p = positions(`
      <header><a href="/logo">logo</a></header>
      <div class="layout">
        <main><article><div class="body"><div><div><div><div><div><p><a href="/in-text">story</a></p></div></div></div></div></div></div></article></main>
        <div class="sidebar"><div class="widget"><ul><li><a href="/popular">popular</a></li></ul></div></div>
      </div>
      <div class="bottom"><a href="/about">about</a></div>
      <footer><a href="/terms">terms</a></footer>`);
    expect(p['/in-text']).toBe('content');
    expect(p['/popular']).not.toBe('content');
    expect(p['/about']).not.toBe('content');
    expect(p['/logo']).toBe('header');
    expect(p['/terms']).toBe('footer');
  });

  it('role landmarks count like their elements', () => {
    const p = positions(`
      <div role="navigation"><a href="/menu">menu</a></div>
      <div role="main"><p><a href="/in-text">story</a></p></div>
      <div role="complementary"><a href="/side">side</a></div>
      <div role="contentinfo"><a href="/terms">terms</a></div>`);
    expect(p).toMatchObject({ '/menu': 'navigation', '/in-text': 'content', '/side': 'sidebar', '/terms': 'footer' });
  });

  it('a page without any main landmark keeps every unmarked link as content', () => {
    expect(positions('<div><p><a href="/x">x</a></p></div>')['/x']).toBe('content');
  });
});

describe('link position: announcement articles (B210)', () => {
  it('an <article> teaser inside a sidebar does not make unmarked body links "aside"', () => {
    const p = positions(`
      <div class="layout">
        <div class="text"><p><a href="/in-text">story</a></p></div>
        <div class="side"><article><h3>Teaser</h3></article></div>
      </div>`);
    expect(p['/in-text']).toBe('content');
  });

  it('a <main> still marks unmarked links outside it as not content', () => {
    const p = positions(`<main><p><a href="/in-text">story</a></p></main><div><a href="/popular">popular</a></div>`);
    expect(p['/in-text']).toBe('content');
    expect(p['/popular']).toBe('aside');
  });
});
