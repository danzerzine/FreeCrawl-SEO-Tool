import * as v8 from 'node:v8';
import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CrawlTrapWatch, describeTrap, isCleanSitemapRead, trapSectionKey, type TrapFinding } from './crawl-trap-watch.js';

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
  it('names ending in id other than the listed ones never count as varying: catid with Itemid (B185)', () => {
    expect(
      feed(settled(), 3000, (i) => `${H}/index.php?catid=${i % 10}&Itemid=${i % 20}&n=${i}`),
    ).toEqual([]);
  });
  it('a pattern needs a fifth of all URLs found: 2 000 of 10 000 fire, of 10 001 do not (B185)', () => {
    const others = (i: number) => `${H}/p/${i}/x`;
    const mix = (plain: number) => (i: number) => (i < plain ? others(i) : facet(i - plain));
    const at = (plain: number) => feed(settled(), plain + 2000, mix(plain));
    expect(at(8000).map((x) => x.rule)).toEqual(['R2']);
    expect(at(8001)).toEqual([]);
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

describe('R1 and R3 need a clean sitemap baseline', () => {
  const sitemap = (n: number, dir = 'p') => Array.from({ length: n }, (_, i) => `${H}/${dir}/${i}/x`);
  const shop = (i: number) => `${H}/shop/item/${i}`;
  const baselineFor = (urls: string[]) => {
    const w = new CrawlTrapWatch();
    w.setBaseline('a.test', urls);
    return w;
  };

  it('R3 fires at 5 000 in one section and not one URL below', () => {
    expect(feed(baselineFor(sitemap(1200)), 4999, shop)).toEqual([]);
    const f = feed(baselineFor(sitemap(1200)), 5000, shop);
    expect(f.map((x) => [x.rule, x.key, x.expected, x.count])).toEqual([['R3', 'a.test/shop', 0, 5000]]);
    expect(f[0]!.samples.length).toBe(3);
  });
  it('R3 is off without a baseline', () => {
    expect(feed(new CrawlTrapWatch(), 9000, shop)).toEqual([]);
  });
  it('R3 needs half of everything counted', () => {
    const w = baselineFor(sitemap(1200));
    const f = feed(w, 11000, (i) => (i % 11 < 5 ? shop(i) : `${H}/other${i % 40}/${i}`));
    expect(f).toEqual([]);
  });
  it('news-only sitemap over 5 000 and 10 000 articles: no finding, R1 is the info line', () => {
    for (const total of [5000, 10000]) {
      const w = baselineFor(sitemap(1000, 'news'));
      expect(feed(w, total, (i) => `${H}/news/a${i}`)).toEqual([]);
      expect(w.snapshot('t').sitemapShort).toEqual({ found: expect.any(Number), listed: 1000 });
    }
  });
  it('R1 needs 5 000 URLs and five times the sitemap, and is reported once', () => {
    const w = baselineFor(sitemap(1000));
    let first: unknown = null;
    let times = 0;
    for (let i = 0; i < 5200; i++)
      if (w.observe(`${H}/news/a${i}`)) {
        const r = w.check();
        if (r.sitemapShort) {
          times++;
          first ??= r.sitemapShort;
        }
      }
    expect(times).toBe(1);
    expect(first).toEqual({ found: 5000, listed: 1000 });
    const small = baselineFor(sitemap(1001));
    for (let i = 0; i < 5000; i++) small.observe(`${H}/news/a${i}`);
    expect(small.check().sitemapShort).toBeNull();
  });
  it('a sitemap of another host, an empty one, leaves the baseline off', () => {
    const w = new CrawlTrapWatch();
    w.setBaseline('www.a.test', sitemap(1200));
    expect(w.hasBaseline).toBe(false);
    expect(feed(w, 9000, shop)).toEqual([]);
    const e = new CrawlTrapWatch();
    e.setBaseline('a.test', []);
    expect(e.hasBaseline).toBe(false);
  });
  it('a calendar of 36 months with distinct content stays quiet', () => {
    const w = baselineFor(sitemap(1200));
    expect(feed(w, 36, (i) => `${H}/events?year=${2024 + Math.floor(i / 12)}&month=${(i % 12) + 1}`)).toEqual([]);
  });
});

describe('findings across a resume', () => {
  it('a restored finding is kept and its key does not fire again', () => {
    const first = new CrawlTrapWatch();
    first.markSettled();
    expect(feed(first, 2500, facet)).toHaveLength(1);
    const snap = first.snapshot('t');
    const again = new CrawlTrapWatch();
    again.markSettled();
    again.restore(JSON.parse(JSON.stringify(snap)));
    expect(feed(again, 3000, facet)).toEqual([]);
    const out = again.snapshot('t2');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.count).toBe(3000);
  });
});

describe('memory and CPU bound', () => {
  const longUrl = (k: number, v: number): string => {
    const names = Array.from({ length: 8 }, (_, j) => `n${String(j)}_${String(k).padStart(5, '0')}_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
    return `https://h.test/seg${k}/x?${names.map((n) => `${n}=v${v}`).join('&')}`;
  };
  const gc = (): void => {
    v8.setFlagsFromString('--expose-gc');
    (vm.runInNewContext('gc') as () => void)();
  };
  const used = (): number => {
    gc();
    const m = process.memoryUsage();
    return m.heapUsed + m.arrayBuffers;
  };

  it('both tables at 5 000 keys of 200 characters, 6 names x 64 values: heap growth < 35 MB, <= 25 us per observe (5 us with FC_TIMING=1)', () => {
    const before = used();
    const w = new CrawlTrapWatch();
    for (let k = 0; k < 5000; k++) for (let v = 0; v < 64; v++) w.observe(longUrl(k, v));
    const after = used();
    const sizes = w.tableSizes();
    expect(sizes.bySection).toBe(5000);
    expect(sizes.byHost).toBe(5000);
    const mb = (after - before) / 1e6;
    console.log(`worst-case fill: ${mb.toFixed(1)} MB for ${JSON.stringify(sizes)}`);
    expect(mb).toBeLessThan(35);

    // The strict 5 us bound is a CPU-time claim that a loaded shared machine cannot keep (6.5 us at load
    // ~90 in the parallel full suite, 3.3 us alone), so it runs only on request:
    //   fc-mac-lock env FC_TIMING=1 npx vitest run packages/core/src/crawl-trap-watch.test.ts -t "5 000 keys"
    // A loose 25 us bound always runs: it cannot flake on a loaded Mac, and a gross regression still fails it.
    const urls = Array.from({ length: 1000 }, (_, i) => longUrl((i * 7) % 5000, i % 64));
    // The cost of the code, not of the machine: warm up, then the best of many short timed batches,
    // each measured in this process's CPU time (not wall time), so a busy machine that takes the core
    // away mid-batch does not count (7.5 us in a parallel full run against 2.65 us idle).
    const BATCH = 20_000;
    const best = (batches: number): number => {
      let us = Infinity;
      for (let b = 0; b < batches; b++) {
        const c0 = process.cpuUsage();
        for (let i = 0; i < BATCH; i++) w.observe(urls[i % 1000]!);
        const c = process.cpuUsage(c0);
        us = Math.min(us, (c.user + c.system) / BATCH);
      }
      return us;
    };
    for (let i = 0; i < 200_000; i++) w.observe(urls[i % 1000]!);
    const strict = process.env.FC_TIMING === '1';
    const us = best(strict ? 50 : 10);
    console.log(`worst-case observe: ${us.toFixed(2)} us per call (best batch, CPU time)`);
    expect(us).toBeLessThanOrEqual(25);
    if (strict) expect(us).toBeLessThanOrEqual(5);
  }, 120_000);

  it('a full table drops idle keys in one batch, never a key above a quarter of the floor, no scan per insert', () => {
    const w = new CrawlTrapWatch({ maxKeys: 100 });
    // one busy key (above 500 = 25 % of the 2 000 floor) and 99 idle ones
    for (let i = 0; i < 600; i++) w.observe(`https://h.test/busy?a=${i % 5}&b=${i % 4}`);
    for (let k = 0; k < 98; k++) w.observe(`https://h.test/s${k}?p${k}=1&q${k}=2`);
    expect(w.tableSizes().byHost).toBe(99);
    const scans0 = w.evictScans;
    // key 100 fits, key 101 meets a full table: one batch
    for (let k = 98; k < 200; k++) w.observe(`https://h.test/s${k}?p${k}=1&q${k}=2`);
    expect(w.patternCount('h.test?a,b')).toBe(600);
    // 102 new keys in each of 3 tables: a scan per ~98 inserts, not one per insert
    expect(w.evictScans - scans0).toBeLessThanOrEqual(6);
    expect(w.evictIterations).toBeLessThanOrEqual(6 * 100);
    expect(w.tableSizes().byHost).toBeLessThanOrEqual(100);
  });
});

describe('which sitemap read counts as a baseline', () => {
  const file = (url: string, status: number | null, error: string | null = null, reason: string | null = null) => ({
    url,
    status,
    error,
    reason,
  });
  const ok = (url: string) => file(url, 200);
  const base = { truncated: false, sitemapsParsed: [1] };
  it('a clean read is a baseline, also with a guessed location that does not exist', () => {
    expect(isCleanSitemapRead({ ...base, files: [ok('https://a.test/sitemap.xml')] }, false)).toBe(true);
    const guessed = new Set(['https://a.test/sitemap_index.xml']);
    const files = [ok('https://a.test/sitemap.xml'), file('https://a.test/sitemap_index.xml', 404, 'HTTP 404')];
    expect(isCleanSitemapRead({ ...base, files }, false, guessed)).toBe(true);
  });
  it.each([
    ['a truncated read', { ...base, truncated: true, files: [ok('u')] }, false],
    ['an abort', { ...base, files: [ok('u')] }, true],
    ['a failed declared file', { ...base, files: [ok('u'), file('v', 500, 'HTTP 500')] }, false],
    ['a declared file that is not found', { ...base, files: [ok('u'), file('v', 404, 'HTTP 404')] }, false],
    ['a file left unread', { ...base, files: [ok('u'), file('v', null, null, 'too-deep')] }, false],
    ['nothing parsed', { truncated: false, sitemapsParsed: [], files: [file('u', 404, 'HTTP 404')] }, false],
  ])('%s is not', (_n, res, aborted) => {
    expect(isCleanSitemapRead(res, aborted)).toBe(false);
  });
});

describe('R3 warning text for a query-only trap at the site root', () => {
  const root = (samples: string[]): TrapFinding => ({
    rule: 'R3',
    key: 'a.test/(root)',
    count: 5258,
    expected: 1,
    share: 0.8,
    samples,
    atCount: 6500,
    host: 'a.test',
  });
  it('names the root readably and suggests an exclude built from the parameter names', () => {
    const text = describeTrap(
      root(['https://a.test/?color=red&page=3', 'https://a.test/?color=blue&page=9']),
      6500,
      1200,
    );
    expect(text).not.toContain('(root)');
    expect(text).toContain('site root');
    expect(text).toContain('(e.g. "color=")');
  });
  it('gives no exclude suggestion when the root URLs carry no query', () => {
    const text = describeTrap(root(['https://a.test/x1', 'https://a.test/x2']), 6500, 1200);
    expect(text).not.toContain('(root)');
    expect(text).not.toContain('e.g.');
    expect(text).toContain('lower the page limit');
  });
  it('keeps a path section as it was', () => {
    const f = { ...root(['https://a.test/blog/a']), key: 'a.test/blog' };
    expect(describeTrap(f, 6500, 1200)).toContain('(e.g. "/blog/")');
  });
});
