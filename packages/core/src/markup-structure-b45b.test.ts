import { describe, expect, it } from 'vitest';
import { checkMarkup } from './markup-check.js';

// B45b: the token-level pass of the markup check: stray end tags, end tags in
// the wrong order, a block inside an inline element, an element under a parent
// it may not have, and an HTML attribute on an element that does not take it.
const DT = '<!DOCTYPE html>';
const codes = (body: string): Record<string, number> => checkMarkup(`${DT}${body}`).codes;

describe('stray end tags (B45b)', () => {
  it('an end tag with no open element of that name', () => {
    expect(codes('<div></div></div>')).toEqual({ 'stray-end-tag': 1 });
    expect(codes('<body></foo>')).toEqual({ 'stray-end-tag': 1 });
    expect(codes('<p>a</p></span>')).toEqual({ 'stray-end-tag': 1 });
  });

  it('an end tag of a void element', () => {
    expect(codes('<p>a<br></br></p>')).toEqual({ 'stray-end-tag': 1 });
    expect(codes('<img src=x alt=""></img>')).toEqual({ 'stray-end-tag': 1 });
  });

  it('a block that closed the paragraph leaves its </p> stray', () => {
    expect(codes('<p><div>x</div></p>')).toEqual({ 'stray-end-tag': 1 });
  });

  it('html, head and body end tags are never stray', () => {
    expect(codes('<html><head></head><body><p>x</p></body></html></body></html>')).toEqual({});
  });
});

describe('end tags in the wrong order (B45b)', () => {
  it('counts once, not also as an unclosed element', () => {
    expect(codes('<p><b><i>x</b></i></p>')).toEqual({ 'misnested-tag': 1 });
    expect(codes('<div><span>x</div></span>')).toEqual({ 'misnested-tag': 1 });
  });

  it('an element its parent closed and that is never closed stays unclosed (B45)', () => {
    expect(codes('<div><span>x</div>')).toEqual({ 'unclosed-element': 1 });
    expect(codes('<div><span>x</div><span>y</span>')).toEqual({ 'unclosed-element': 1 });
  });
});

describe('block inside an inline element (B45b)', () => {
  it('a block element in phrasing content', () => {
    expect(codes('<span><div>x</div></span>')).toEqual({ 'block-in-inline': 1 });
    expect(codes('<h2><p>x</p></h2>')).toEqual({ 'block-in-inline': 1 });
    expect(codes('<button><div>x</div></button>')).toEqual({ 'block-in-inline': 1 });
    expect(codes('<span><a href="/"><ul><li>x</li></ul></a></span>')).toEqual({ 'block-in-inline': 1 });
  });

  it('a link around a block is fine where the link may hold flow content', () => {
    expect(codes('<div><a href="/"><div>x</div></a></div>')).toEqual({});
    expect(codes('<a href="/"><h2>t</h2><p>x</p></a>')).toEqual({});
  });
});

describe('element under a parent it may not have (B45b)', () => {
  it('list items, cells, options and the like', () => {
    expect(codes('<div><li>x</li></div>')).toEqual({ 'wrong-parent': 1 });
    expect(codes('<table><td>x</td></table>')).toEqual({ 'wrong-parent': 1 });
    expect(codes('<div><option>x</option></div>')).toEqual({ 'wrong-parent': 1 });
    expect(codes('<div><figcaption>x</figcaption></div>')).toEqual({ 'wrong-parent': 1 });
  });

  it('the right parents, implied closes and template content are clean', () => {
    expect(codes('<ul><li>a<li>b</ul><ol><li>c</li></ol>')).toEqual({});
    expect(codes('<table><caption>c<tr><td>x<td>y<tr><th>z</table>')).toEqual({});
    expect(codes('<table><thead><tr><th>a</thead><tbody><tr><td>b</tbody></table>')).toEqual({});
    expect(codes('<dl><dt>a<dd>b</dl><dl><div><dt>c</dt><dd>d</dd></div></dl>')).toEqual({});
    expect(codes('<select><optgroup label=g><option>a<option>b</optgroup></select>')).toEqual({});
    expect(codes('<template><li>x</li><td>y</td></template>')).toEqual({});
    expect(codes('<picture><source srcset=a.webp><img src=a.png alt=""></picture>')).toEqual({});
    expect(codes('<figure><img src=a alt=""><figcaption>x</figcaption></figure>')).toEqual({});
  });
});

describe('attribute the element does not take (B45b)', () => {
  it('an HTML attribute on the wrong element', () => {
    expect(codes('<div href="/x">x</div>')).toEqual({ 'attribute-not-allowed': 1 });
    expect(codes('<span value="1" src="a.png">x</span>')).toEqual({ 'attribute-not-allowed': 2 });
    expect(codes('<span itemprop="price" content="10">10</span>')).toEqual({ 'attribute-not-allowed': 1 });
  });

  it('global, data-, aria-, event, framework and custom-element attributes are not checked', () => {
    expect(
      codes(
        '<div id=a class=b style="c" title=d lang=en hidden tabindex=0 data-src=x aria-label=y onclick="f()" v-if="z" x-data="{}" :class="k" @click="m">x</div>',
      ),
    ).toEqual({});
    expect(codes('<my-widget href="/x" src="y">x</my-widget>')).toEqual({});
  });

  it('element attributes in their place are clean, svg included', () => {
    expect(
      codes(
        '<a href="/" target=_blank rel=noopener download hreflang=en>a</a><img src=a alt="" width=1 height=1 loading=lazy srcset="a 1x" sizes="1px">' +
          '<form action="/" method=post><label for=q>q</label><input id=q type=text name=q value=1 placeholder=p required>' +
          '<select name=s><option value=1 selected>1</option></select><textarea name=t rows=2 cols=3></textarea><button type=submit>go</button></form>' +
          '<svg width="10" height="10" viewBox="0 0 10 10"><a href="#a"><rect x="1" y="1" width="2" height="2"/></a></svg>',
      ),
    ).toEqual({});
  });
});

describe('the rest of the B45 check is unchanged', () => {
  it('a clean page stays clean', () => {
    expect(
      checkMarkup(`${DT}<html><head><title>t</title><meta charset=utf-8></head><body><p id="a">x</p></body></html>`),
    ).toEqual({ total: 0, codes: {} });
  });

  it('script, style, title and textarea text is not read as tags', () => {
    expect(codes('<script>if (a</b) document.write("</div><li>")</script><style>p{}</style>')).toEqual({});
  });

  it('the new codes are capped and summed like the others', () => {
    const r = checkMarkup(`${DT}${'</span>'.repeat(1200)}<div href=x></div>`);
    expect(r.codes).toEqual({ 'stray-end-tag': 1000, 'attribute-not-allowed': 1 });
    expect(r.total).toBe(1001);
  });
});
