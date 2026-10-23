import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import type { LinkSuggestionInput, LinkSuggestionResult } from '@freecrawl/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkSuggestions, type LinkSuggestionInternals } from './link-suggestions.js';
import { isTopWordStopword } from './top-words.js';

const BASE = 'https://ex.com';

interface Page {
  id: number;
  path: string;
  title?: string | null;
  h1?: string | null;
  desc?: string | null;
  status?: number;
  indexability?: string;
  kind?: string;
  external?: 0 | 1;
  cluster?: number;
  hash?: string | null;
  score?: number | null;
  outlinks?: number;
  redirectTarget?: string | null;
  redirectFinal?: string | null;
}

interface Link {
  from: number;
  to: string; // a path, or a full URL
  rel?: string | null;
  type?: string;
  pos?: string | null;
  internal?: 0 | 1;
}

interface Fixture {
  pages: Page[];
  links?: Link[];
  /** project_meta rows; `inlinksComputed` defaults to '1'. */
  meta?: Record<string, string>;
}

let dir: string;
let file: string;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fc-b93-'));
  file = path.join(dir, `p${seq++}.seoproject`);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const abs = (p: string): string => (p.startsWith('http') ? p : BASE + p);

function build(fx: Fixture): string {
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const meta = { inlinksComputed: '1', ...(fx.meta ?? {}) };
  const putMeta = raw.prepare('INSERT OR REPLACE INTO project_meta (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(meta)) if (v !== '') putMeta.run(k, v);
  const putUrl = raw.prepare(
    `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title, h1,
       meta_description, outlinks, link_score, cluster_id, content_hash, redirect_target, redirect_final_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of fx.pages) {
    putUrl.run(
      p.id,
      abs(p.path),
      p.external ?? 0,
      p.kind ?? 'html',
      p.status ?? 200,
      p.indexability ?? 'indexable',
      p.title ?? null,
      p.h1 ?? null,
      p.desc ?? null,
      p.outlinks ?? 10,
      p.score ?? null,
      p.cluster ?? 0,
      p.hash ?? null,
      p.redirectTarget === undefined || p.redirectTarget === null ? null : abs(p.redirectTarget),
      p.redirectFinal === undefined || p.redirectFinal === null ? null : abs(p.redirectFinal),
    );
  }
  const putLink = raw.prepare(
    `INSERT INTO links (from_url_id, to_url, rel, is_internal, type, link_position)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const l of fx.links ?? []) {
    putLink.run(l.from, abs(l.to), l.rel ?? null, l.internal ?? 1, l.type ?? 'hyperlink', l.pos ?? null);
  }
  raw.close();
  return file;
}

function run(
  fx: Fixture | null,
  input: LinkSuggestionInput = {},
  internals: LinkSuggestionInternals = {},
): LinkSuggestionResult | null {
  if (fx) build(fx);
  const db = new ProjectDb(file);
  try {
    return linkSuggestions(db, input, internals);
  } finally {
    db.close();
  }
}

/** Letters only (the tokeniser drops digits): a unique pseudo-word per number. */
function uniq(i: number): string {
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  } while (n > 0);
  return 'zq' + s + 'x';
}

const rowsOf = (r: LinkSuggestionResult | null, targetPath: string) =>
  (r?.rows ?? []).filter((x) => x.targetUrl === abs(targetPath));
const sourcesOf = (r: LinkSuggestionResult | null, targetPath: string): string[] =>
  rowsOf(r, targetPath)
    .filter((x) => x.rank > 0)
    .map((x) => x.sourceUrl!.replace(BASE, ''));

describe('stopword helper', () => {
  it('knows the bundled stopwords of every locale', () => {
    expect(isTopWordStopword('the')).toBe(true);
    expect(isTopWordStopword('the', 'en')).toBe(true);
    expect(isTopWordStopword('the', 'ru')).toBe(false);
    expect(isTopWordStopword('который', 'ru')).toBe(true);
    expect(isTopWordStopword('espresso')).toBe(false);
  });
});

describe('linkSuggestions (B93)', () => {
  // 1
  it('suggests an on-topic page that does not link a page with no inlinks', () => {
    const r = run({
      pages: [
        { id: 1, path: '/', title: 'Home' },
        { id: 2, path: '/espresso-guide', title: 'Espresso machine buying guide', h1: 'Espresso machine guide' },
        { id: 3, path: '/grinders', title: 'Coffee grinders for espresso machine', h1: 'Grinders for espresso' },
        { id: 4, path: '/tea', title: 'Green tea ceremony', h1: 'Tea ceremony' },
        { id: 5, path: '/football', title: 'Football league results', h1: 'Football results' },
      ],
      links: [
        { from: 1, to: '/grinders' },
        { from: 1, to: '/tea' },
        { from: 1, to: '/football' },
      ],
    });
    expect(r).not.toBeNull();
    const rows = rowsOf(r, '/espresso-guide');
    expect(rows[0]!.rank).toBe(1);
    expect(rows[0]!.sourceUrl).toBe(BASE + '/grinders');
    expect(rows[0]!.targetInlinks).toBe(0);
    expect(rows[0]!.closeness).toBeGreaterThanOrEqual(20);
    expect(rows[0]!.closeness).toBeLessThanOrEqual(100);
    expect(sourcesOf(r, '/espresso-guide')).toEqual(['/grinders']);
  });

  // 2
  it('never suggests a source that already links, by nofollow, an image or a redirect', () => {
    const r = run({
      pages: [
        { id: 1, path: '/t', title: 'Espresso machine guide', h1: 'Espresso guide' },
        { id: 2, path: '/nofollow', title: 'Espresso machine reviews' },
        { id: 3, path: '/image', title: 'Espresso machine pictures' },
        { id: 4, path: '/viaredirect', title: 'Espresso machine maintenance' },
        { id: 5, path: '/control', title: 'Espresso machine descaling' },
        { id: 6, path: '/r', status: 301, indexability: 'indexable', redirectTarget: '/t', kind: 'html' },
      ],
      links: [
        { from: 2, to: '/t', rel: 'nofollow' },
        { from: 3, to: '/t', type: 'image' },
        { from: 4, to: '/r' },
      ],
    });
    expect(sourcesOf(r, '/t')).toEqual(['/control']);
  });

  // 3
  it('leaves out sources that are not indexable pages', () => {
    const r = run({
      pages: [
        { id: 1, path: '/t', title: 'Espresso machine guide', h1: 'Espresso guide' },
        { id: 2, path: '/noindex', title: 'Espresso machine noindex page', indexability: 'non-indexable:noindex' },
        { id: 3, path: '/canon', title: 'Espresso machine canonical page', indexability: 'non-indexable:canonicalised' },
        { id: 4, path: '/gone', title: 'Espresso machine missing page', status: 404 },
        { id: 5, path: '/moved', title: 'Espresso machine moved page', status: 301, redirectTarget: '/control' },
        { id: 6, path: '/robots', title: 'Espresso machine blocked page', indexability: 'non-indexable:robots' },
        { id: 7, path: 'https://other.com/ext', title: 'Espresso machine external page', external: 1 },
        { id: 8, path: '/control', title: 'Espresso machine control page' },
      ],
    });
    expect(sourcesOf(r, '/t')).toEqual(['/control']);
    for (const x of r!.rows) expect(x.sourceUrl).not.toBe(x.targetUrl);
  });

  // 4
  it('drops duplicates of the target by cluster, content hash or title+h1, with cluster_id 0 everywhere', () => {
    const r = run({
      pages: [
        { id: 1, path: '/t', title: 'Alpine hiking trails guide', h1: 'Hiking trails', hash: 'abc', cluster: 7 },
        { id: 2, path: '/cluster', title: 'Alpine hiking trails overview', cluster: 7 },
        { id: 3, path: '/hash', title: 'Alpine hiking trails summary', hash: 'abc' },
        { id: 4, path: '/twin', title: 'Alpine hiking trails guide', h1: 'Hiking trails' },
        { id: 5, path: '/control', title: 'Alpine hiking trails maps' },
      ],
    });
    expect(sourcesOf(r, '/t')).toEqual(['/control']);

    // the same fixture without cluster ids: hash and twin still go
    const file2 = path.join(dir, 'zero.seoproject');
    file = file2;
    const r2 = run({
      pages: [
        { id: 1, path: '/t', title: 'Alpine hiking trails guide', h1: 'Hiking trails', hash: 'abc' },
        { id: 3, path: '/hash', title: 'Alpine hiking trails summary', hash: 'abc' },
        { id: 4, path: '/twin', title: '  alpine Hiking  trails guide ', h1: 'hiking trails' },
        { id: 5, path: '/control', title: 'Alpine hiking trails maps' },
      ],
    });
    expect(sourcesOf(r2, '/t')).toEqual(['/control']);
  });

  // 5
  it('counts effective inlinks as distinct eligible sources with redirects folded', () => {
    const r = run(
      {
        pages: [
          { id: 1, path: '/a', title: 'Quantum widget handbook' },
          { id: 2, path: '/r', status: 301, redirectTarget: '/a' },
          { id: 3, path: '/x', title: 'Gardening notes spring' },
          { id: 4, path: '/y', title: 'Sailing boats weekend' },
          { id: 5, path: '/v', title: 'Cooking pasta quickly' },
          { id: 6, path: '/z', title: 'Hidden draft page', indexability: 'non-indexable:noindex' },
        ],
        links: [
          { from: 3, to: '/a' },
          { from: 3, to: '/r' },
          { from: 4, to: '/a' },
          { from: 4, to: '/a' },
          { from: 4, to: '/a' },
          { from: 5, to: '/r' },
          { from: 6, to: '/a' },
          { from: 1, to: '/a' },
        ],
      },
      { maxInlinks: 50 },
    );
    expect(rowsOf(r, '/a')[0]!.targetInlinks).toBe(3);
  });

  // 6
  it('ignores template links and never lists the template URL as a target', () => {
    const pages: Page[] = [
      { id: 1, path: '/', title: 'Home page' },
      { id: 2, path: '/p1', title: 'Cheese making' },
      { id: 3, path: '/p2', title: 'Wine tasting' },
      { id: 4, path: '/p3', title: 'Bread baking' },
      { id: 5, path: '/p4', title: 'Olive pressing' },
      { id: 6, path: '/about', title: 'About the company' },
    ];
    const links: Link[] = [1, 2, 3, 4, 5].map((from) => ({ from, to: '/about' }));
    const r = run({ pages, links }, { maxInlinks: 10 });
    expect(rowsOf(r, '/about')).toEqual([]);
    expect(r!.rows.length).toBeGreaterThan(0);
  });

  // 7
  it('caps suggestions per target', () => {
    const pages: Page[] = [{ id: 1, path: '/t', title: 'Espresso machine guide', outlinks: 200 }];
    for (let i = 0; i < 8; i++) {
      pages.push({ id: 2 + i, path: `/s${i}`, title: `Espresso machine ${uniq(i)} tips` });
    }
    const r = run({ pages }, { perTarget: 3, minCloseness: 0 });
    expect(rowsOf(r, '/t').map((x) => x.rank)).toEqual([1, 2, 3]);
  });

  it('offers one hub to at most perSource targets and lists the rest as rank 0', () => {
    const pages: Page[] = [{ id: 1, path: '/hub', title: 'Coffee hub', outlinks: 10 }];
    for (let i = 0; i < 20; i++) {
      pages.push({ id: 2 + i, path: `/t${String(i).padStart(2, '0')}`, title: `Coffee ${uniq(i)}`, outlinks: 200 });
    }
    // The hub is linked by enough pages to be no target itself.
    const links: Link[] = [];
    const r = run({ pages, links }, { minCloseness: 0, maxInlinks: 0 });
    const hubRows = r!.rows.filter((x) => x.sourceUrl === BASE + '/hub');
    expect(hubRows.length).toBe(10);
    expect(r!.rows.filter((x) => x.rank === 0).length).toBeGreaterThanOrEqual(10);
    // fewest inlinks first, then url: the first ten targets got it
    expect(hubRows.map((x) => x.targetUrl.replace(BASE, '')).sort()[0]).toBe('/t00');
  });

  it('lists a target with no source above minCloseness as one rank 0 row', () => {
    const r = run({
      pages: [
        { id: 1, path: '/lonely', title: 'Zebra migration patterns' },
        { id: 2, path: '/other', title: 'Quarterly tax filing deadlines' },
      ],
    });
    const rows = rowsOf(r, '/lonely');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rank: 0, sourceUrl: null, closeness: null, suggestedAnchor: null });
    expect(r!.withoutSuggestion).toBeGreaterThanOrEqual(1);
  });

  it('orders ties by link score, then fewer outlinks, then url', () => {
    const same = 'Espresso machine care';
    const r = run(
      {
        pages: [
          { id: 1, path: '/t', title: 'Espresso machine buying guide', outlinks: 200 },
          { id: 2, path: '/s1', title: same, score: 50, outlinks: 20 },
          { id: 3, path: '/s2', title: same, score: 50, outlinks: 10 },
          { id: 4, path: '/s3', title: same, score: 10, outlinks: 5 },
          { id: 5, path: '/s4', title: same, score: 50, outlinks: 10 },
        ],
      },
      { perTarget: 4, minCloseness: 0 },
    );
    expect(sourcesOf(r, '/t')).toEqual(['/s2', '/s4', '/s1', '/s3']);
    const closeness = new Set(rowsOf(r, '/t').map((x) => x.closeness));
    expect(closeness.size).toBe(1);
  });

  // 8
  it.each([
    {
      name: 'en',
      target: 'Saffron harvest festival',
      rare: 'Saffron fields tour',
      common: 'Festival schedule overview',
      filler: (i: number) => `Travel guide festival ${uniq(i)}`,
    },
    {
      name: 'ru',
      target: 'Шафран сбор урожая праздник',
      rare: 'Шафран на полях экскурсия',
      common: 'Праздник расписание обзор',
      filler: (i: number) => `Путеводитель праздник ${uniq(i)}`,
    },
  ])('ranks the page sharing the rare word above the one sharing a common word ($name)', (c) => {
    const pages: Page[] = [
      { id: 1, path: '/t', title: c.target, outlinks: 200 },
      { id: 2, path: '/rare', title: c.rare },
      { id: 3, path: '/common', title: c.common },
    ];
    for (let i = 0; i < 12; i++) pages.push({ id: 4 + i, path: `/f${i}`, title: c.filler(i) });
    // perSource is lifted: every page here is a weak target too, and /t sorts last by url.
    const r = run({ pages }, { minCloseness: 0, perTarget: 20, perSource: 100 });
    const src = sourcesOf(r, '/t');
    expect(src.indexOf('/rare')).toBeGreaterThanOrEqual(0);
    expect(src.indexOf('/common')).toBeGreaterThanOrEqual(0);
    expect(src.indexOf('/rare')).toBeLessThan(src.indexOf('/common'));
  });

  // 9
  it('answers null when the inlink pass has not run', () => {
    const r = run({ pages: [{ id: 1, path: '/a', title: 'Alpha page' }], meta: { inlinksComputed: '' } });
    expect(r).toBeNull();
  });

  // 10
  it('reads an old read-only file that lacks link_score and link_position', () => {
    build({
      pages: [
        { id: 1, path: '/t', title: 'Espresso machine guide', h1: 'Espresso guide' },
        { id: 2, path: '/s', title: 'Espresso machine care', score: 40 },
      ],
      links: [{ from: 2, to: '/s', pos: 'content' }],
    });
    const raw = new DatabaseSync(file);
    raw.exec('ALTER TABLE urls DROP COLUMN link_score');
    raw.exec('ALTER TABLE links DROP COLUMN link_position');
    raw.close();
    const db = new ProjectDb(file, { readOnly: true });
    let r: LinkSuggestionResult | null;
    try {
      r = linkSuggestions(db, {});
    } finally {
      db.close();
    }
    expect(r).not.toBeNull();
    const row = rowsOf(r, '/t')[0]!;
    expect(row.sourceUrl).toBe(BASE + '/s');
    expect(row.sourceLinkScore).toBeNull();
    expect(row.targetLinkScore).toBeNull();
    expect(row.targetContentInlinks).toBe(0);
    expect(r!.missingColumns).toEqual(expect.arrayContaining(['link_score', 'link_position']));
  });

  // 10a
  it('folds redirects one hop when chains are not computed, and through chains when they are', () => {
    const pages: Page[] = [
      { id: 1, path: '/a', title: 'Espresso machine guide', h1: 'Espresso guide', outlinks: 200 },
      { id: 2, path: '/r1', status: 301, redirectTarget: '/r2' },
      { id: 3, path: '/r2', status: 301, redirectTarget: '/a' },
      { id: 4, path: '/x', title: 'Espresso machine cleaning' },
      { id: 5, path: '/y', title: 'Espresso machine descaling' },
      { id: 6, path: '/w', title: 'Espresso machine warranty' },
    ];
    const links: Link[] = [
      { from: 4, to: '/r1' }, // two hops away
      { from: 5, to: '/r2' }, // one hop away
    ];
    const one = run({ pages, links });
    expect(one!.redirectsFolded).toBe('one-hop');
    expect(sourcesOf(one, '/a').sort()).toEqual(['/w', '/x']);
    expect(rowsOf(one, '/a')[0]!.targetInlinks).toBe(1);

    file = path.join(dir, 'chains.seoproject');
    const two = run({
      pages: pages.map((p) =>
        p.path === '/r1' || p.path === '/r2' ? { ...p, redirectFinal: '/a' } : p,
      ),
      links,
      meta: { redirectChainsComputed: '1' },
    });
    expect(two!.redirectsFolded).toBeUndefined();
    expect(sourcesOf(two, '/a')).toEqual(['/w']);
    expect(rowsOf(two, '/a')[0]!.targetInlinks).toBe(2);
  });

  // 11
  it('walks no posting list above the cap', () => {
    const pages: Page[] = [];
    for (let i = 0; i < 1000; i++) {
      pages.push({ id: i + 1, path: `/p${i}`, title: `Commonword ${uniq(i)}` });
    }
    const stats: NonNullable<LinkSuggestionInternals['stats']> = { maxListWalked: 0, listsSkipped: 0 };
    const started = Date.now();
    const r = run({ pages }, { minCloseness: 0, maxTargets: 50 }, { postingCap: 200, dfCut: 5000, stats });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(stats.listsSkipped).toBeGreaterThan(0);
    expect(stats.maxListWalked).toBeLessThanOrEqual(200);
    expect(r!.rows.every((x) => x.rank === 0)).toBe(true);
  });

  // 11a
  it('keeps a topical word that 6 titles share in a 200-page crawl (document frequency floor)', () => {
    const pages: Page[] = [{ id: 1, path: '/kayak-tours', title: 'Kayak rental tours' }];
    for (let i = 0; i < 5; i++) pages.push({ id: 2 + i, path: `/k${i}`, title: `Kayak rental ${uniq(i)}` });
    for (let i = 0; i < 194; i++) {
      pages.push({ id: 10 + i, path: `/f${i}`, title: `${uniq(100 + i)} ${uniq(400 + i)}` });
    }
    const r = run({ pages });
    expect(sourcesOf(r, '/kayak-tours').length).toBeGreaterThanOrEqual(1);
    expect(sourcesOf(r, '/kayak-tours')[0]).toMatch(/^\/k\d$/);
  });

  // 11b
  it('applies the exclusions before the cut', () => {
    const pages: Page[] = [
      { id: 1, path: '/t', title: 'Alpine hiking trails guide', outlinks: 200 },
      { id: 2, path: '/m1', title: 'Alpine hiking trails guide maps' },
      { id: 3, path: '/m2', title: 'Alpine hiking trails guide books' },
      { id: 4, path: '/m3', title: 'Alpine hiking trails guide boots', hash: 'dup' },
      { id: 5, path: '/m4', title: 'Alpine hiking trails guide huts', hash: 'dup' },
      { id: 6, path: '/m5', title: 'Hiking tips' },
    ];
    pages[0]!.hash = 'dup';
    const links: Link[] = [
      { from: 2, to: '/t' },
      { from: 3, to: '/t' },
    ];
    const r = run({ pages, links }, { perTarget: 1, minCloseness: 0 });
    expect(sourcesOf(r, '/t')).toEqual(['/m5']);
  });

  it('skips a source whose perSource budget is spent and fills from the next candidate', () => {
    const pages: Page[] = [
      { id: 1, path: '/a1', title: 'Alpine lake swimming spots', outlinks: 200 },
      { id: 2, path: '/a2', title: 'Alpine lake swimming places', outlinks: 200 },
      { id: 3, path: '/z-hub', title: 'Alpine lake swimming guide' },
      { id: 4, path: '/z-hub2', title: 'Alpine hiking trails' },
      { id: 5, path: '/l1', title: 'Cheese rolling' },
      { id: 6, path: '/l2', title: 'Pottery wheels' },
      { id: 7, path: '/l3', title: 'Chess openings' },
      { id: 8, path: '/l4', title: 'Origami folds' },
    ];
    const links: Link[] = [5, 6, 7, 8].flatMap((from) => [
      { from, to: '/z-hub' },
      { from, to: '/z-hub2' },
    ]);
    const r = run({ pages, links }, { perSource: 1, perTarget: 1, minCloseness: 0, maxInlinks: 3 });
    expect(sourcesOf(r, '/a1')).toEqual(['/z-hub']);
    expect(sourcesOf(r, '/a2')).toEqual(['/z-hub2']);
  });

  // 11c
  describe('suggestedAnchor', () => {
    const withSuffix = (n: number): Page[] =>
      Array.from({ length: n }, (_, i) => ({
        id: 100 + i,
        path: `/pad${i}`,
        title: `${uniq(900 + i)} ${uniq(950 + i)} | Daily Site`,
        h1: `${uniq(990 + i)} header`,
      }));

    it('prefers the h1', () => {
      const r = run({
        pages: [
          { id: 1, path: '/t', title: 'Alps hiking | Daily Site', h1: 'Hiking in the Alps' },
          { id: 2, path: '/s', title: 'Alps hiking boots | Daily Site' },
          ...withSuffix(5),
        ],
      });
      expect(rowsOf(r, '/t')[0]!.suggestedAnchor).toBe('Hiking in the Alps');
    });

    it('removes the site suffix that most titles share', () => {
      const r = run({
        pages: [
          { id: 1, path: '/t', title: 'Mountain biking trails | Daily Site' },
          { id: 2, path: '/s', title: 'Mountain biking helmets | Daily Site' },
          ...withSuffix(5),
        ],
      });
      expect(rowsOf(r, '/t')[0]!.suggestedAnchor).toBe('Mountain biking trails');
    });

    it('keeps the title when no suffix is shared', () => {
      const r = run({
        pages: [
          { id: 1, path: '/t', title: 'Mountain biking trails - Alpha' },
          { id: 2, path: '/s', title: 'Mountain biking helmets - Beta' },
          { id: 3, path: '/u', title: 'Gardening tools - Gamma' },
          { id: 4, path: '/v', title: 'Sailing knots - Delta' },
        ],
      });
      expect(rowsOf(r, '/t')[0]!.suggestedAnchor).toBe('Mountain biking trails - Alpha');
    });

    it('cuts at a word boundary at 80 characters', () => {
      const long = Array.from({ length: 30 }, (_, i) => `mountain${i % 2 ? 'ous' : ''}`.padEnd(9, 'x')).join(' ');
      expect(long.length).toBeGreaterThan(80);
      const r = run({
        pages: [
          { id: 1, path: '/t', title: 'Short', h1: long },
          { id: 2, path: '/s', title: 'mountainxx mountainous mountain' },
        ],
      }, { minCloseness: 0 });
      const anchor = rowsOf(r, '/t')[0]!.suggestedAnchor!;
      expect(anchor.length).toBeLessThanOrEqual(80);
      expect(long.startsWith(anchor)).toBe(true);
      expect(long[anchor.length]).toBe(' ');
    });
  });

  // 11d
  it('returns truncated when the time budget is spent and degraded when the posting guard trips', () => {
    const pages: Page[] = [];
    for (let i = 0; i < 30; i++) pages.push({ id: i + 1, path: `/p${i}`, title: `Shared topic ${uniq(i)}` });
    const cut = run({ pages }, {}, { budgetMs: 0 });
    expect(cut!.truncated).toBe(true);
    expect(cut!.rows.length).toBeLessThan(30);

    file = path.join(dir, 'degraded.seoproject');
    const thin = run({ pages }, {}, { maxPostings: 5 });
    expect(thin!.degraded).toBe(true);

    file = path.join(dir, 'plain.seoproject');
    const plain = run({ pages });
    expect(plain!.truncated).toBe(false);
    expect(plain!.degraded).toBe(false);
  });

  it('marks truncated when more weak pages exist than maxTargets', () => {
    const pages: Page[] = [];
    for (let i = 0; i < 10; i++) pages.push({ id: i + 1, path: `/p${i}`, title: `Subject ${uniq(i)}` });
    const r = run({ pages }, { maxTargets: 4 });
    expect(r!.targets).toBe(4);
    expect(r!.truncated).toBe(true);
  });

  // 11e
  it('reports sameSection with the first path segment as the section', () => {
    const r = run({
      pages: [
        { id: 1, path: '/news/a/x', title: 'Espresso machine guide', outlinks: 200 },
        { id: 2, path: '/news/b', title: 'Espresso machine news' },
        { id: 3, path: '/blog/c', title: 'Espresso machine blog' },
      ],
    });
    const byUrl = new Map(rowsOf(r, '/news/a/x').map((x) => [x.sourceUrl!.replace(BASE, ''), x.sameSection]));
    expect(byUrl.get('/news/b')).toBe(true);
    expect(byUrl.get('/blog/c')).toBe(false);
  });
});
