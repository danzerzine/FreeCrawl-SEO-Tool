import { describe, expect, it } from 'vitest';
import { CrawlTrapWatch, trapSectionKey } from './crawl-trap-watch.js';

const H = 'https://a.test';

/** Feed `n` URLs made by `make(i)` and return every finding the checks produced. */
function feed(w: CrawlTrapWatch, n: number, make: (i: number) => string) {
  const out = [] as ReturnType<CrawlTrapWatch['check']>['findings'];
  for (let i = 0; i < n; i++) if (w.observe(make(i))) out.push(...w.check().findings);
  out.push(...w.check().findings);
  return out;
}
const facet = (i: number) => `${H}/shop?color=c${i % 7}&size=s${i % 5}&page=${i % 50}&u=${i}`;

describe('section key', () => {
  it.each([
    [`${H}/a`, 'a.test/(root)'],
    [`${H}/a/`, 'a.test/(root)'],
    [`${H}/`, 'a.test/(root)'],
    [`${H}/blog/x`, 'a.test/blog'],
    [`${H}/blog/x/y`, 'a.test/blog'],
    [`${H}/blog/x?y=1#f`, 'a.test/blog'],
    [`${H}/index.php?route=product/product&product_id=7`, 'a.test/index.php route=product/product'],
    [`${H}/index.php?product_id=7&route=product/category`, 'a.test/index.php route=product/category'],
    [`${H}/?option=com_content&view=article&id=3`, 'a.test/(root) option=com_content'],
    [`${H}/shop/list.php?controller=item&id=1`, 'a.test/shop controller=item'],
  ])('%s -> %s', (url, key) => {
    expect(trapSectionKey(url)).toBe(key);
  });
});

describe('R2 one parameter pattern grows', () => {
  const settled = () => {
    const w = new CrawlTrapWatch();
    w.markSettled();
    return w;
  };
  it('fires at its floor of 2 000 and not one URL below', () => {
    expect(feed(settled(), 1999, facet)).toEqual([]);
    const f = feed(settled(), 2000, facet);
    expect(f.map((x) => x.rule)).toEqual(['R2']);
    expect(f[0]).toMatchObject({ count: 2000, expected: null, share: 1 });
    expect(f[0]!.key).toBe('a.test?color,page,size,u');
    expect(f[0]!.samples).toHaveLength(3);
  });
  it('is held until the sitemap read settled, or the count reaches twice the floor', () => {
    const w = new CrawlTrapWatch();
    expect(feed(w, 3999, facet)).toEqual([]);
    expect(feed(new CrawlTrapWatch(), 4000, facet)).toHaveLength(1);
  });
  it('fires once per crawl for the same key', () => {
    const w = settled();
    expect(feed(w, 2500, facet)).toHaveLength(1);
    expect(feed(w, 2500, (i) => facet(i + 5000))).toEqual([]);
  });
  it('a plain forum ?t=N of 5 000 topics is silent', () => {
    expect(feed(settled(), 5000, (i) => `${H}/viewtopic.php?t=${i}`)).toEqual([]);
  });
  it('one varying name that is not trap-prone is silent, a ?q= one fires', () => {
    expect(feed(settled(), 5000, (i) => `${H}/list?page=${i}`)).toEqual([]);
    expect(feed(settled(), 5000, (i) => `${H}/list?tag=t${i}`)).toEqual([]);
    expect(feed(settled(), 2000, (i) => `${H}/find?q=w${i}`)).toHaveLength(1);
  });
  it('a two-varying-name pattern fires', () => {
    expect(
      feed(settled(), 2000, (i) => `${H}/list?color=c${i % 9}&size=s${i % 4}&n=${i}`),
    ).toHaveLength(1);
  });
  it('id-like names never count as varying: id, Itemid, product_id, digits-only with > 64 values', () => {
    expect(
      feed(settled(), 5000, (i) => `${H}/x.php?id=${i}&Itemid=${i % 30}&product_id=${i}&tid=${i % 9}`),
    ).toEqual([]);
    expect(feed(settled(), 5000, (i) => `${H}/x?ref2=${i}&ref3=${i % 99}`)).toEqual([]);
  });
  it('routing names never count as varying', () => {
    expect(
      feed(settled(), 5000, (i) => `${H}/index.php?option=o${i % 9}&view=v${i % 9}&layout=l${i % 9}&task=t${i % 9}`),
    ).toEqual([]);
  });
  it('OpenCart-style store and Joomla non-SEF site are silent', () => {
    const oc = (i: number) => `${H}/index.php?route=product/product&product_id=${i}`;
    expect(feed(settled(), 3000, oc)).toEqual([]);
    const jm = (i: number) =>
      `${H}/index.php?option=com_content&view=${['article', 'category', 'featured'][i % 3]}&id=${i}&Itemid=${100 + (i % 12)}`;
    expect(feed(settled(), 3000, jm)).toEqual([]);
  });
  it('a pattern the sitemap lists as often is silent; a trap beside a clean sitemap still fires', () => {
    const w = new CrawlTrapWatch();
    w.setBaseline('a.test', Array.from({ length: 2500 }, (_, i) => facet(i)));
    expect(feed(w, 2500, facet)).toEqual([]);
    const w2 = new CrawlTrapWatch();
    w2.setBaseline('a.test', Array.from({ length: 1200 }, (_, i) => `${H}/p/${i}/x`));
    const f = feed(w2, 2500, facet);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'R2', expected: 0 });
  });
  it('filters over 50 category paths fire through the host + names aggregate', () => {
    const f = feed(settled(), 2500, (i) => `${H}/c${i % 50}?color=c${i % 8}&size=s${i % 5}`);
    expect(f).toHaveLength(1);
    expect(f[0]!.key).toBe('a.test?color,size');
  });
  it('cuts keys at 200 characters', () => {
    const names = Array.from({ length: 40 }, (_, k) => `longparametername${k}`);
    const w = settled();
    const f = feed(w, 2000, (i) => `${H}/s?${names.map((n) => `${n}=${i % 9}`).join('&')}`);
    expect(f[0]!.key.length).toBeLessThanOrEqual(200);
  });
});
