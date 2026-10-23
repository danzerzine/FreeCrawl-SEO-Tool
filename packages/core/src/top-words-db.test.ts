import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSectionedTopWords, sectionOf } from './top-words.js';
import { topWordsBlocks, topWordsBlocksAsync, topWordsForUrl } from './top-words-db.js';

let dir: string;
let file: string;
let db: ProjectDb | undefined;

interface Page {
  id: number;
  url: string;
  title: string;
  desc?: string;
  h1?: string;
  body?: string;
}
const esc = (s: string): string => s.replace(/'/g, "''");

function load(pages: Page[]): void {
  const raw = new DatabaseSync(file);
  for (const p of pages) {
    raw.exec(
      `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title, meta_description, h1)
       VALUES (${p.id}, '${p.url}', 0, 'html', 200, 'indexable', '${esc(p.title)}', ${p.desc ? `'${esc(p.desc)}'` : 'NULL'}, ${p.h1 ? `'${esc(p.h1)}'` : 'NULL'})`,
    );
    if (p.body) {
      raw.exec(`INSERT INTO url_sources (url_id, body, body_length) VALUES (${p.id}, '${esc(p.body)}', ${p.body.length})`);
    }
  }
  raw.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-b84-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
});
afterEach(() => {
  db?.close();
  db = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

const SITE = [
  { id: 1, url: 'https://ex.test/news/a', title: 'Кофе новости Москвы', h1: 'Кофе дня' },
  { id: 2, url: 'https://ex.test/news/b', title: 'Кофе новости недели' },
  { id: 3, url: 'https://ex.test/news/x/c', title: 'Кофе новости региона' },
  { id: 4, url: 'https://ex.test/shop/a', title: 'Чай купить дёшево', desc: 'Чай зелёный' },
  { id: 5, url: 'https://ex.test/shop/b', title: 'Чай купить подарок' },
  { id: 6, url: 'https://ex.test/', title: 'Главная страница' },
];

describe('B84 sectionOf', () => {
  it('first segment by default, two with depth 2, root is "/"', () => {
    expect(sectionOf('https://ex.com/news/a', 1)).toBe('news');
    expect(sectionOf('https://ex.com/news/a', 2)).toBe('news/a');
    expect(sectionOf('https://ex.com/news', 2)).toBe('news');
    expect(sectionOf('https://ex.com/', 1)).toBe('/');
    expect(sectionOf('https://ex.com', 2)).toBe('/');
    expect(sectionOf('not a url', 1)).toBeNull();
  });
});

describe('B84 seoTextCorpus', () => {
  it('without arguments yields the same strings as before', () => {
    load(SITE);
    db = new ProjectDb(file);
    expect([...db.seoTextCorpus()]).toEqual([
      'Кофе новости Москвы Кофе дня',
      'Кофе новости недели',
      'Кофе новости региона',
      'Чай купить дёшево Чай зелёный',
      'Чай купить подарок',
      'Главная страница',
    ]);
  });

  it('with a scope yields {url, text}; a section filters in the query', () => {
    load(SITE);
    db = new ProjectDb(file);
    const all = [...db.seoTextCorpus({})];
    expect(all.map((r) => r.url)).toHaveLength(6);
    expect([...db.seoTextCorpus({ section: 'shop' })].map((r) => r.url)).toEqual([
      'https://ex.test/shop/a',
      'https://ex.test/shop/b',
    ]);
    expect([...db.seoTextCorpus({ section: 'news/x', depth: 2 })].map((r) => r.url)).toEqual([
      'https://ex.test/news/x/c',
    ]);
    expect([...db.seoTextCorpus({ section: '/' })].map((r) => r.url)).toEqual(['https://ex.test/']);
    expect([...db.seoTextCorpus({ url: 'https://ex.test/shop/b' })].map((r) => r.text)).toEqual([
      'Чай купить подарок',
    ]);
  });

  it('LIKE wildcards in a section name do not match other sections', () => {
    load([
      { id: 1, url: 'https://ex.test/a_b/x', title: 'alpha beta' },
      { id: 2, url: 'https://ex.test/axb/x', title: 'gamma delta' },
    ]);
    db = new ProjectDb(file);
    expect([...db.seoTextCorpus({ section: 'a_b' })].map((r) => r.url)).toEqual(['https://ex.test/a_b/x']);
  });
});

describe('B84 section index page', () => {
  const PAGES = [
    { id: 1, url: 'https://ex.test/news', title: 'Кофе главная' },
    { id: 2, url: 'https://ex.test/news?p=2', title: 'Кофе вторая' },
    { id: 3, url: 'https://ex.test/news/a', title: 'Кофе статья' },
    { id: 4, url: 'https://ex.test/newsletter', title: 'Чай рассылка' },
  ];

  it('a single section includes the folder page without a trailing slash, with or without a query', () => {
    load(PAGES);
    db = new ProjectDb(file);
    expect([...db.seoTextCorpus({ section: 'news' })].map((r) => r.url).sort()).toEqual([
      'https://ex.test/news',
      'https://ex.test/news/a',
      'https://ex.test/news?p=2',
    ]);
    expect([...db.seoTextCorpus({ section: 'news/a', depth: 2 })].map((r) => r.url)).toEqual([
      'https://ex.test/news/a',
    ]);
  });

  it('one section gives the same counts as the same section in the by-section block', () => {
    load(PAGES);
    db = new ProjectDb(file);
    const by = topWordsBlocks(db, { locale: 'ru', bySection: true }).find((b) => b.section === 'news')!;
    const one = topWordsBlocks(db, { locale: 'ru', section: 'news' });
    expect(one).toHaveLength(1);
    expect(one[0]!.rows).toEqual(by.rows);
    expect(by.rows.find((r) => r.word === 'кофе')).toEqual({ word: 'кофе', count: 3, pages: 3 });
  });
});

describe('B84 per-section top words', () => {
  it('two sections give different top words that add up to the site', () => {
    load(SITE);
    db = new ProjectDb(file);
    const blocks = topWordsBlocks(db, { locale: 'ru', bySection: true });
    const by = new Map(blocks.map((b) => [b.section, b]));
    expect([...by.keys()].sort()).toEqual(['/', 'news', 'shop']);
    expect(by.get('news')!.rows[0]).toEqual({ word: 'кофе', count: 4, pages: 3 });
    expect(by.get('shop')!.rows[0]).toEqual({ word: 'чай', count: 3, pages: 2 });
    const site = topWordsBlocks(db, { locale: 'ru' });
    expect(site).toHaveLength(1);
    expect(site[0]!.scope).toBe('site');
    expect(site[0]!.rows.find((r) => r.word === 'кофе')).toEqual({ word: 'кофе', count: 4, pages: 3 });
    // counts of one word add up across the sections
    const sum = (w: string): number =>
      blocks.reduce((a, b) => a + (b.rows.find((r) => r.word === w)?.count ?? 0), 0);
    expect(sum('новости')).toBe(site[0]!.rows.find((r) => r.word === 'новости')!.count);
  });

  it('depth 2 splits news/x from news', () => {
    load(SITE);
    db = new ProjectDb(file);
    const blocks = topWordsBlocks(db, { locale: 'ru', bySection: true, sectionDepth: 2 });
    expect(blocks.map((b) => b.section)).toEqual(['/', 'news/a', 'news/b', 'news/x', 'shop/a', 'shop/b']);
  });
});

describe('B84 sectioned aggregator keeps at most 50 sections', () => {
  it('60 sections of different size: 50 largest + (other); per-section limit', () => {
    const pagesPerSection = new Map<string, number>();
    for (let i = 0; i < 60; i++) pagesPerSection.set(`s${i}`, 100 - i);
    const agg = createSectionedTopWords({ locale: 'en', n: 2, minCount: 1, sectionPages: pagesPerSection });
    for (let i = 0; i < 60; i++) agg.add(`https://ex.test/s${i}/p`, 'alpha beta');
    const out = agg.result();
    expect(out).toHaveLength(51);
    expect(out.map((b) => b.section)).toContain('(other)');
    const other = out.find((b) => b.section === '(other)')!;
    expect(other.rows).toEqual([{ word: 'alpha beta', count: 10, pages: 10 }]);
    expect(out.find((b) => b.section === 's0')).toBeDefined();
    expect(out.find((b) => b.section === 's55')).toBeUndefined();
    expect(agg.limitPerSection).toBe(20_000);
    expect(51 * agg.limitPerSection).toBeLessThanOrEqual(1_100_000);
  });

  it('few sections share the 200 000 grams: limit = max(20 000, 200 000 / count)', () => {
    const agg = createSectionedTopWords({ locale: 'en', n: 2, sectionPages: new Map([['a', 5], ['b', 3]]) });
    expect(agg.limitPerSection).toBe(100_000);
  });
});

describe('B84 page scope', () => {
  it('a stored body adds its body-only words; without a body only title, description and H1', () => {
    load([
      {
        id: 1,
        url: 'https://ex.test/p',
        title: 'Coffee beans',
        desc: 'Fresh roast',
        h1: 'Beans',
        body: '<html><body><main><p>Zanzibar zanzibar plantation</p></main></body></html>',
      },
      { id: 2, url: 'https://ex.test/q', title: 'Coffee beans', h1: 'Beans' },
    ]);
    db = new ProjectDb(file);
    const withBody = topWordsForUrl(db, 'https://ex.test/p', { locale: 'en' });
    expect(withBody.find((r) => r.word === 'zanzibar')).toMatchObject({ count: 2, pages: 1 });
    expect(withBody.find((r) => r.word === 'beans')).toMatchObject({ count: 2 });
    const without = topWordsForUrl(db, 'https://ex.test/q', { locale: 'en' });
    expect(without.map((r) => r.word).sort()).toEqual(['beans', 'coffee']);
    expect(topWordsForUrl(db, 'https://ex.test/missing', { locale: 'en' })).toEqual([]);
  });
});

describe('B84 one section and the async body reader (desktop)', () => {
  it('section restricts the site block to the pages of that folder', () => {
    load(SITE);
    db = new ProjectDb(file);
    const blocks = topWordsBlocks(db, { locale: 'ru', section: 'shop' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ scope: 'section', section: 'shop' });
    expect(blocks[0]!.rows.map((r) => r.word)).toContain('чай');
    expect(blocks[0]!.rows.map((r) => r.word)).not.toContain('кофе');
  });

  it('topWordsBlocksAsync with a prose reader gives what the sync call gives', async () => {
    load([
      { id: 1, url: 'https://ex.test/a/1', title: 'Кофе', body: '<html><body><main><p>эспрессо эспрессо</p></main></body></html>' },
      { id: 2, url: 'https://ex.test/b/1', title: 'Чай', body: '<html><body><main><p>эспрессо</p></main></body></html>' },
    ]);
    db = new ProjectDb(file);
    const seen: string[] = [];
    const asyncBlocks = await topWordsBlocksAsync(db, {
      locale: 'ru',
      bySection: true,
      withBodies: true,
      prose: async (body) => {
        seen.push(body);
        return body.replace(/<[^>]+>/g, ' ');
      },
    });
    expect(seen).toHaveLength(2);
    expect(asyncBlocks.find((b) => b.section === 'a')!.rows.find((r) => r.word === 'эспрессо')).toEqual({ word: 'эспрессо', count: 2, pages: 1 });
    const sync = topWordsBlocks(db, { locale: 'ru', bySection: true, withBodies: true });
    expect(asyncBlocks).toEqual(sync);
  });
});

describe('B84 page scope through topWordsBlocks', () => {
  it('url gives one block of scope page, with the body of that page when the project has it', async () => {
    load([
      { id: 1, url: 'https://ex.test/p', title: 'Coffee beans', body: '<html><body><main><p>Zanzibar plantation</p></main></body></html>' },
    ]);
    db = new ProjectDb(file);
    const blocks = topWordsBlocks(db, { locale: 'en', url: 'https://ex.test/p' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ scope: 'page', section: 'https://ex.test/p', n: 1, capped: false });
    expect(blocks[0]!.rows.map((r) => r.word)).toContain('zanzibar');
    const viaAsync = await topWordsBlocksAsync(db, { locale: 'en', url: 'https://ex.test/p', prose: async (b) => b });
    expect(viaAsync).toEqual(blocks);
  });
});
