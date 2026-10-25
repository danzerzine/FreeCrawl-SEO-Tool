import { describe, expect, it } from 'vitest';
import { checkMarkup, MARKUP_CODES } from './markup-check.js';

const DT = '<!DOCTYPE html>';
const codes = (html: string): Record<string, number> => checkMarkup(html).codes;

describe('checkMarkup (B45)', () => {
  it('the rule list is the 8 stable codes, then the 5 of B45b appended', () => {
    expect([...MARKUP_CODES]).toEqual([
      'missing-doctype',
      'duplicate-attribute',
      'malformed-tag',
      'unexpected-end',
      'bad-character-reference',
      'duplicate-id',
      'obsolete-element',
      'unclosed-element',
      'stray-end-tag',
      'misnested-tag',
      'block-in-inline',
      'wrong-parent',
      'attribute-not-allowed',
    ]);
  });

  it('a clean page is {total:0, codes:{}}', () => {
    expect(checkMarkup(`${DT}<html><head><title>t</title></head><body><p id="a">x</p></body></html>`)).toEqual({
      total: 0,
      codes: {},
    });
  });

  it('missing doctype', () => {
    expect(codes('<p>x')).toEqual({ 'missing-doctype': 1 });
  });

  it('duplicate attribute on one tag', () => {
    expect(codes(`${DT}<p id=a id=b>`)).toEqual({ 'duplicate-attribute': 1 });
  });

  it('duplicate id counts every extra element', () => {
    expect(codes(`${DT}<p id="x">a</p><p id="x">b</p>`)).toEqual({ 'duplicate-id': 1 });
    expect(codes(`${DT}<p id="x">a</p><p id="x">b</p><p id="x">c</p><p id="">d</p><p id="">e</p>`)).toEqual({
      'duplicate-id': 2,
    });
  });

  it('obsolete element', () => {
    expect(codes(`${DT}<center>x</center>`)).toEqual({ 'obsolete-element': 1 });
  });

  it('malformed tag', () => {
    expect(codes(`${DT}<a href="x"<b>`)).toEqual({ 'malformed-tag': 2, 'unclosed-element': 1 });
  });

  it('unexpected end', () => {
    expect(codes(`${DT}<!-- open`)).toEqual({ 'unexpected-end': 1 });
  });

  it('bad character reference; a bare ampersand in a URL is not one', () => {
    expect(codes(`${DT}&foo;`)).toEqual({ 'bad-character-reference': 1 });
    expect(codes(`${DT}<a href="?a=1&b=2">x</a>`)).toEqual({});
  });

  it('unclosed element: implied close by a parent end tag', () => {
    expect(codes(`${DT}<div><span>x</div>`)).toEqual({ 'unclosed-element': 1 });
    expect(codes(`${DT}<span/>x`)).toEqual({ 'unclosed-element': 1 });
  });

  it('inline svg and math self-closing children are clean', () => {
    expect(
      codes(`${DT}<svg><path d="M0"/><circle r="1"/><use href="#i"/></svg><math><mi/></math>`),
    ).toEqual({});
  });

  it('optional end tags and void elements are not errors', () => {
    expect(codes('<table><caption>c<tr><td>x</table>')).toEqual({ 'missing-doctype': 1 });
    expect(codes(`${DT}<table><caption>c<tr><td>x</table>`)).toEqual({});
    expect(codes(`${DT}<ul><li>a<li>b</ul><p>a<p>b<img src=x><br>`)).toEqual({});
    expect(codes(`${DT}<ruby>a<rb>b<rt>c<rtc>d</ruby>`)).toEqual({});
  });

  it('stray end tags come from the structure pass (B45b) and count once', () => {
    // parse5 7.3.0 and htmlparser2 10.1.0 do not report them; if an upgrade starts
    // to, a parser code would double this count and the mapping has to be reviewed.
    expect(codes(`${DT}<div></div></div>`)).toEqual({ 'stray-end-tag': 1 });
    expect(codes(`${DT}<body></foo>`)).toEqual({ 'stray-end-tag': 1 });
  });

  it('input over 2 MB: the cut creates no unexpected-end / unclosed-element', () => {
    const big = `${DT}<html><body>${'<div><p>x</p></div>'.repeat(140_000)}</body></html>`;
    expect(big.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(checkMarkup(big)).toEqual({ total: 0, codes: {} });
    // other codes still count in the head that was read
    const dup = `${DT}<p id="x">a</p><p id="x">b</p>${'<i>y</i>'.repeat(400_000)}`;
    expect(checkMarkup(dup).codes).toEqual({ 'duplicate-id': 1 });
  });

  it('caps each code at 1000', () => {
    const many = `${DT}${'<center>x</center>'.repeat(1500)}`;
    expect(checkMarkup(many)).toEqual({ total: 1000, codes: { 'obsolete-element': 1000 } });
  });
});
