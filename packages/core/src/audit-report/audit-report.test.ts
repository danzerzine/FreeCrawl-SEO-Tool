import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDb } from '@freecrawl/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseExportWhat } from '../export-items.js';
import { buildAuditData, clickDepthFrom, healthScore, type AuditIssue } from './data.js';
import { exportAuditReport } from './index.js';
import { renderAuditReport, startItems } from './render.js';
import { AUDIT_FONT_FACES } from './fonts.generated.js';
import { fmtPct, plural } from './texts.js';

const S = 'https://example.com';
// 16 crawled HTML pages: 13 open to search, two canonicalised to another
// page, one blocked by robots.txt. No page has a meta description (a
// template-wide check: 15 of 16 pages answer 200); /blog/untitled has no
// title (a critical check on one page); /shop/item has no inlinks.
const PAGES: [number, string, string, number | null, string | null][] = [
  [1, '/', 'indexable', 200, 'Home of the example site for the audit'],
  ...Array.from({ length: 10 }, (_, i): [number, string, string, number, string] => [
    i + 2,
    `/blog/post-${i + 1}`,
    'indexable',
    200,
    `Blog post number ${i + 1} of the example site`,
  ]),
  [12, '/blog/dup-a', 'non-indexable:canonical', 200, 'Duplicate A of a post on the example site'],
  [13, '/blog/dup-b', 'non-indexable:canonical', 200, 'Duplicate B of a post on the example site'],
  [14, '/private/x', 'non-indexable:robots-blocked', null, null],
  [15, '/blog/untitled', 'indexable', 200, null],
  [16, '/shop/item', 'indexable', 200, 'A shop item on the example site for tests'],
];
// Home → posts 1-2, dup-a, dup-b, untitled; then a chain post-1 → post-3 → … → post-10.
const LINKS: [number, number][] = [
  [1, 2],
  [1, 3],
  [1, 12],
  [1, 13],
  [1, 15],
  [2, 4],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [8, 9],
  [9, 10],
  [10, 11],
];

let dir: string;
let file: string;

function urlOf(id: number): string {
  return S + PAGES.find((p) => p[0] === id)![1];
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-audit-'));
  file = path.join(dir, 'p.seoproject');
  new ProjectDb(file).close();
  const raw = new DatabaseSync(file);
  const ins = raw.prepare(
    `INSERT INTO urls (id, url, is_external, content_kind, status_code, indexability, title, title_length,
                       inlinks, response_time_ms, crawled_at)
     VALUES (?, ?, 0, 'html', ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [id, p, idx, status, title] of PAGES) {
    const inlinks = LINKS.filter(([, to]) => to === id).length;
    ins.run(
      id,
      S + p,
      status,
      idx,
      title,
      title ? title.length : null,
      inlinks,
      status ? 30 + id : null,
      `2026-01-0${id === 16 ? 2 : 1} 10:00:${String(id).padStart(2, '0')}`,
    );
  }
  const link = raw.prepare(
    `INSERT INTO links (from_url_id, to_url, is_internal, type) VALUES (?, ?, ?, ?)`,
  );
  for (const [from, to] of LINKS) link.run(from, urlOf(to), 1, 'hyperlink');
  link.run(1, 'https://elsewhere.example.org/', 0, 'hyperlink');
  link.run(16, `${S}/shop/item.png`, 1, 'image');
  const sm = raw.prepare(
    `INSERT INTO sitemap_urls (url, source_sitemap) VALUES (?, '${S}/sitemap.xml')`,
  );
  for (const u of ['/', '/blog/post-1', '/blog/dup-a', '/not-crawled']) sm.run(S + u);
  raw
    .prepare(`INSERT OR REPLACE INTO project_meta (key, value) VALUES ('startUrl', ?)`)
    .run(`${S}/`);
  raw.close();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function withDb<T>(fn: (db: ProjectDb) => T): T {
  const db = new ProjectDb(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function addTraffic(kind: 'metrica' | 'gsc'): void {
  const raw = new DatabaseSync(file);
  const rows: [string, number][] = [
    [`${S}/blog/post-1`, 50],
    [`${S}/`, 30],
    [`${S}/amp/x`, 20],
    ['https://other.example.org/', 100],
  ];
  if (kind === 'metrica') {
    const ins = raw.prepare(
      `INSERT INTO metrica_results (url, account_id, search_visits, visits, fetched_at) VALUES (?, 'c1', ?, ?, '2026-01-03')`,
    );
    for (const [u, v] of rows) ins.run(u, v, v);
    raw
      .prepare(`INSERT OR REPLACE INTO project_meta (key, value) VALUES ('metricaFetchMeta:c1', ?)`)
      .run(JSON.stringify({ startDate: '2025-12-01', endDate: '2025-12-31' }));
  } else {
    const ins = raw.prepare(
      `INSERT INTO gsc_results (url, account_id, clicks, fetched_at) VALUES (?, 'g1', ?, '2026-01-03')`,
    );
    for (const [u, v] of rows) ins.run(u, v);
  }
  raw.close();
}

describe('buildAuditData', () => {
  it('counts pages, the pages open to search and why the rest are closed', () => {
    const d = withDb((db) => buildAuditData(db));
    expect(d.host).toBe('example.com');
    expect(d.totals.html).toBe(16);
    expect(d.totals.indexable).toBe(13);
    expect(d.nonIndexable).toEqual([
      { reason: 'canonical', count: 2 },
      { reason: 'robots-blocked', count: 1 },
    ]);
    expect(d.status).toEqual({ '200': 15, '0': 1 });
    expect(d.crawlFirst).toBe('2026-01-01 10:00:01');
    expect(d.crawlLast).toBe('2026-01-02 10:00:16');
  });

  it('measures click depth by BFS over hyperlinks from the start page', () => {
    const d = withDb((db) => buildAuditData(db));
    // home 0; post-1, post-2, dup-a, dup-b, untitled 1; post-3 2; … post-7 6, post-8..10 deeper (6+).
    expect(d.clickDepth).toEqual([1, 5, 1, 1, 1, 1, 4]);
    // /private/x and /shop/item: no hyperlink path (the image link does not count).
    expect(d.orphans).toBe(2);
  });

  it('flags the template-wide check and keeps the critical one per page', () => {
    const d = withDb((db) => buildAuditData(db));
    const meta = d.issues.find((it) => it.key === 'issues:meta-missing')!;
    expect(meta.urlsHtml).toBe(15);
    expect(meta.templateWide).toBe(true);
    const title = d.issues.find((it) => it.key === 'issues:title-missing')!;
    expect(title.severity).toBe('critical');
    expect(title.templateWide).toBe(false);
    expect(title.urlsIndexable).toBe(1);
    expect(title.impact).toBe(1);
    expect(title.examples).toEqual([`${S}/blog/untitled`]);
    for (let i = 1; i < d.issues.length; i++) {
      const [a, b] = [d.issues[i - 1]!, d.issues[i]!];
      expect(a.impact > b.impact || (a.impact === b.impact && a.urls >= b.urls)).toBe(true);
    }
    // The score charges each template-wide check once and is the rounded mean minus that.
    expect(d.score.templatePenalty).toBeGreaterThanOrEqual(5);
    expect(d.score.value).toBe(
      Math.max(0, Math.round(d.score.pageMean!) - d.score.templatePenalty),
    );
  });

  it('compares the sitemap with the crawl', () => {
    const d = withDb((db) => buildAuditData(db));
    expect(d.sitemap).toEqual({
      inSitemap: 4,
      inSitemapNotCrawled: 1,
      indexableNotInSitemap: 11,
      nonIndexableInSitemap: 1,
    });
  });

  it('groups sections by the first path segment', () => {
    const d = withDb((db) => buildAuditData(db));
    expect(d.sections.map((s) => [s.section, s.pages, s.indexable])).toEqual([
      ['/blog/', 13, 11],
      ['/', 1, 1],
      ['/private/', 1, 0],
      ['/shop/', 1, 1],
    ]);
    expect(d.sections[0]!.withCritical).toBeGreaterThanOrEqual(1);
  });

  it('takes the page limit, robots.txt and user agent from the crawl config', () => {
    const d = withDb((db) =>
      buildAuditData(db, {
        crawlConfig: { maxUrls: 16, respectRobotsTxt: true, userAgent: 'ExampleBot/1.0' },
      }),
    );
    expect(d.settings).toEqual({
      maxUrls: 16,
      respectRobotsTxt: true,
      userAgent: 'ExampleBot/1.0',
    });
    expect(d.limitHit).toBe(true);
    const bare = withDb((db) => buildAuditData(db));
    expect(bare.settings).toEqual({ maxUrls: null, respectRobotsTxt: null, userAgent: null });
    expect(bare.limitHit).toBe(false);
  });

  it('has no traffic block without search traffic rows', () => {
    const d = withDb((db) => buildAuditData(db));
    expect(d.traffic).toBeNull();
    const html = renderAuditReport(d);
    expect(html).not.toContain('поисковый трафик');
    expect(html).not.toContain('id="own-h"');
  });

  it('sets pages against Metrica search visits per section, on the crawled host only', () => {
    addTraffic('metrica');
    const t = withDb((db) => buildAuditData(db)).traffic!;
    expect(t.source).toBe('metrica');
    expect(t.totalVisits).toBe(100);
    expect(t.uncrawledVisits).toBe(20);
    expect(t.uncrawledTop).toEqual({ section: '/amp/', visits: 20 });
    expect([t.periodStart, t.periodEnd]).toEqual(['2025-12-01', '2025-12-31']);
    const blog = t.rows.find((r) => r.section === '/blog/')!;
    expect(blog).toMatchObject({ indexable: 11, visits: 50, zeroVisitPages: 10, visitsShare: 0.5 });
    expect(blog.indexableShare).toBeCloseTo(11 / 13);
    // Sorted by the gap between page share and visit share.
    const gaps = t.rows.map((r) => Math.abs(r.indexableShare - r.visitsShare));
    expect([...gaps].sort((a, b) => b - a)).toEqual(gaps);
    expect(t.rows.some((r) => r.section === '/private/')).toBe(false);
  });

  it('falls back to Search Console clicks', () => {
    addTraffic('gsc');
    const t = withDb((db) => buildAuditData(db)).traffic!;
    expect(t.source).toBe('gsc');
    expect(t.totalVisits).toBe(100);
  });
});

describe('length buckets', () => {
  it('sorts pages open to search into missing / short / ok / long by the project limits, limits inclusive', () => {
    const raw = new DatabaseSync(file);
    raw
      .prepare(`INSERT OR REPLACE INTO project_meta (key, value) VALUES ('seoThresholds', ?)`)
      .run(
        JSON.stringify({
          titleMinChars: 30,
          titleMaxChars: 60,
          descriptionMinChars: 70,
          descriptionMaxChars: 155,
        }),
      );
    // 13 pages open to search: ids 1-11, 15, 16. Closed pages (12-14) are not counted.
    const set = raw.prepare(
      'UPDATE urls SET title_length = ?, meta_description_length = ? WHERE id = ?',
    );
    const rows: [number, number | null, number | null][] = [
      [1, 29, 69], // short, short
      [2, 30, 70], // ok at the lower limit
      [3, 60, 155], // ok at the upper limit
      [4, 61, 156], // long, long
      [5, 200, 300], // long, long
      [12, 5, 5], // closed to search: ignored
      [15, null, null], // missing
    ];
    for (const [id, t, m] of rows) set.run(t, m, id);
    for (const id of [6, 7, 8, 9, 10, 11, 16]) set.run(45, 120, id);
    raw.close();
    const d = withDb((db) => buildAuditData(db));
    expect(d.titles).toEqual({ missing: 1, short: 1, ok: 9, long: 2 });
    expect(d.descriptions).toEqual({ missing: 1, short: 1, ok: 9, long: 2 });
    const html = renderAuditReport(d);
    expect(html).toContain('длиннее 155');
    // The description advice follows the same limits, so following it never trips the long bucket.
    expect(html).not.toContain('120–160');
    expect(html).toContain('70–155 знаков из анонса');
  });
});

describe('one fix in the template', () => {
  const only = (d: ReturnType<typeof buildAuditData>, urlsIndexable: number) => ({
    ...d,
    issues: [
      {
        key: 'issues:h1-missing' as AuditIssue['key'],
        label: 'Missing H1',
        group: 'H1',
        severity: 'warning' as const,
        urls: urlsIndexable,
        urlsHtml: urlsIndexable,
        urlsIndexable,
        share: urlsIndexable / 16,
        templateWide: false,
        impact: urlsIndexable * 0.4,
        examples: [],
      },
    ],
  });
  it('is claimed for an issue on 90% or more of the pages open to search, not below', () => {
    const d = withDb((db) => buildAuditData(db));
    expect(d.totals.indexable).toBe(13);
    const wide = renderAuditReport(only(d, 12)); // 92%
    expect(wide).toContain('Главная правка — одна строка в шаблоне');
    expect(wide).toContain('Это одна правка в шаблоне сайта.');
    expect(wide).toContain('Одна правка, 92%');
    const narrow = renderAuditReport(only(d, 11)); // 85%
    expect(narrow).not.toContain('Главная правка — одна строка в шаблоне');
    expect(narrow).not.toContain('одна правка в шаблоне');
    expect(narrow).not.toContain('Одна правка,');
    expect(narrow).toContain('85%');
  });
});

describe('healthScore', () => {
  it('averages page scores, leaves template-wide checks out of them and charges them once', () => {
    const issues = [
      { key: 'issues:title-missing', severity: 'critical' as const, templateWide: false },
      { key: 'issues:h1-missing', severity: 'warning' as const, templateWide: false },
      { key: 'issues:meta-missing', severity: 'warning' as const, templateWide: true },
      { key: 'issues:canonical-missing', severity: 'critical' as const, templateWide: true },
      { key: 'issues:x', severity: 'info' as const, templateWide: false },
    ];
    const ids = new Map<string, number[]>([
      ['issues:title-missing', [1, 4]],
      ['issues:h1-missing', [2]],
      ['issues:meta-missing', [1, 2, 3]],
      ['issues:canonical-missing', [1, 2, 3]],
      ['issues:x', [3]],
    ]);
    // Page 4 is closed to search: not counted. Pages: 50, 90, 100 → mean 80; then −15 −5.
    const { score } = healthScore(issues, ids, new Set([1, 2, 3]));
    expect(score).toEqual({ pageMean: 80, templatePenalty: 20, value: 60 });
  });

  it('floors a page at 0 and the site at 0', () => {
    const issues = [
      { key: 'a', severity: 'critical' as const, templateWide: false },
      { key: 'b', severity: 'critical' as const, templateWide: false },
      { key: 'c', severity: 'critical' as const, templateWide: false },
      ...Array.from({ length: 8 }, (_, i) => ({
        key: `t${i}`,
        severity: 'critical' as const,
        templateWide: true,
      })),
    ];
    const ids = new Map<string, number[]>([
      ['a', [1]],
      ['b', [1]],
      ['c', [1]],
    ]);
    const { score } = healthScore(issues, ids, new Set([1, 2]));
    expect(score.pageMean).toBe(50);
    expect(score.value).toBe(0);
    expect(healthScore([], new Map(), new Set()).score.value).toBeNull();
  });
});

describe('clickDepthFrom', () => {
  it('accepts the start URL with or without its trailing slash and caps at 6+', () => {
    const byUrl = new Map(Array.from({ length: 9 }, (_, i) => [`${S}/p${i}/`, i]));
    byUrl.set(`${S}/`, 100);
    const links = [
      { fromId: 100, toUrl: `${S}/p0/` },
      ...Array.from({ length: 8 }, (_, i) => ({ fromId: i, toUrl: `${S}/p${i + 1}/` })),
    ];
    expect(clickDepthFrom(S, byUrl, links)).toEqual({
      clickDepth: [1, 1, 1, 1, 1, 1, 4],
      orphans: 0,
    });
    expect(clickDepthFrom(`${S}/nope`, byUrl, links)).toEqual({
      clickDepth: [0, 0, 0, 0, 0, 0, 0],
      orphans: 10,
    });
  });
});

describe('startItems', () => {
  const issue = (
    key: string,
    group: string,
    severity: 'critical' | 'warning',
    impact: number,
  ): AuditIssue => ({
    key: key as AuditIssue['key'],
    label: key,
    group,
    severity,
    urls: impact,
    urlsHtml: impact,
    urlsIndexable: impact,
    share: 0.1,
    templateWide: false,
    impact,
    examples: [],
  });
  it('ranks by impact on search, security headers and accessibility at half weight', () => {
    const issues = [
      issue('issues:x-content-type-options-missing', 'Security Headers', 'warning', 100),
      issue('issues:canonical-missing', 'Canonicals', 'warning', 80),
      issue('issues:title-missing', 'Page Titles', 'critical', 60),
      issue('issues:h1-missing', 'H1', 'warning', 40),
    ];
    expect(startItems({ issues }).map((it) => it.key)).toEqual([
      'issues:canonical-missing',
      'issues:title-missing',
      'issues:x-content-type-options-missing',
    ]);
  });
});

describe('renderAuditReport', () => {
  it('makes no request: fonts inlined, no stylesheet, script, image or import from the network', () => {
    addTraffic('metrica');
    const html = withDb((db) => renderAuditReport(buildAuditData(db)));
    expect(html).not.toMatch(/<(link|script|iframe)\b/i);
    expect(html).not.toMatch(/\bsrc\s*=\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/@import/i);
    expect(html).toContain('src:url(data:font/woff2;base64,');
    // Links to example pages are fine: they are anchors, not resources.
    expect(html).toContain(`<a class="ex" href="${S}/blog/untitled">/blog/untitled</a>`);
  });

  it('renders Russian by default and English on request, decimals in the locale', () => {
    addTraffic('metrica');
    const d = withDb((db) => buildAuditData(db));
    const ru = renderAuditReport(d);
    const en = renderAuditReport(d, { lang: 'en' });
    expect(ru).toContain('<html lang="ru">');
    expect(ru).toContain('Все проблемы по порядку');
    expect(ru).toContain('Нет заголовка страницы');
    expect(ru).toContain('Где страницы и где поисковый трафик');
    expect(ru).toContain('<span>7,7%</span>'); // the home section: 1 of 13 pages open to search
    expect(ru).not.toContain('<span>7.7%</span>');
    expect(en).toContain('<html lang="en">');
    expect(en).toContain('All problems in order');
    expect(en).toContain('No page title');
    expect(en).toContain('<span>7.7%</span>');
    expect(en).not.toContain('<span>7,7%</span>');
    expect(en).not.toMatch(/[а-яё]/i);
  });

  it('shows the pre-penalty mean in the score note and the result in the ring', () => {
    const d = withDb((db) => buildAuditData(db));
    const html = renderAuditReport(d);
    expect(html).toContain(`<b>${d.score.value}</b><small>из 100</small>`);
    expect(html).toContain(`затем среднее по страницам (${Math.round(d.score.pageMean!)})`);
    expect(html).toContain(`здесь −${d.score.templatePenalty}`);
  });

  it('puts branding in the header and only takes a data: logo and a hex accent', () => {
    const d = withDb((db) => buildAuditData(db));
    const plain = renderAuditReport(d);
    expect(plain).not.toContain('class="brand"');
    const branded = renderAuditReport(d, {
      branding: {
        brandName: 'Example Agency',
        preparedBy: 'Jane Doe',
        accentColor: '#123abc',
        logoDataUrl: 'data:image/png;base64,AAAA',
      },
    });
    expect(branded).toContain(
      '<span class="brand"><img src="data:image/png;base64,AAAA" alt="">Example Agency</span>',
    );
    expect(branded).toContain('Подготовил: Jane Doe');
    expect(branded).toContain(':root{--accent-pine:#123abc}');
    const unsafe = renderAuditReport(d, {
      branding: { logoDataUrl: 'https://example.com/logo.png', accentColor: 'red;}body{x:y' },
    });
    expect(unsafe).not.toContain('logo.png');
    expect(unsafe).not.toContain('--accent-pine:red');
  });

  it('collapses groups with nothing wrong into chips', () => {
    const d = withDb((db) => buildAuditData(db));
    expect(d.cleanGroups.length).toBeGreaterThan(0);
    expect(d.cleanGroups).not.toContain('Page Titles');
    expect(d.cleanGroups).not.toContain('Meta Descriptions');
    expect(renderAuditReport(d)).toContain('Проверено, в порядке');
  });

  it('fits the font budget', () => {
    const html = withDb((db) => renderAuditReport(buildAuditData(db)));
    expect(Buffer.byteLength(html)).toBeLessThan(400 * 1024);
  });
});

describe('exportAuditReport', () => {
  it('writes the file and is an --what kind', async () => {
    const out = path.join(dir, 'audit.html');
    await withDb((db) => exportAuditReport(db, out, { lang: 'en' }));
    expect(fs.readFileSync(out, 'utf8')).toContain('Technical health');
    expect(fs.existsSync(`${out}.part`)).toBe(false);
    expect(parseExportWhat('audit')).toEqual([{ kind: 'audit', name: 'audit' }]);
  });
});

describe('texts', () => {
  it('formats shares and Russian plurals', () => {
    expect(fmtPct(1, 1000, 'ru')).toBe('0,1%');
    expect(fmtPct(1, 1000, 'en')).toBe('0.1%');
    expect(fmtPct(0, 10, 'ru')).toBe('0%');
    expect(fmtPct(1, 0, 'ru')).toBe('—');
    expect(
      [1, 2, 5, 11, 21, 112].map((n) => plural(n, ['страница', 'страницы', 'страниц'], 'ru')),
    ).toEqual(['страница', 'страницы', 'страниц', 'страниц', 'страница', 'страниц']);
  });
});

describe('fonts.generated', () => {
  it('matches the font files in assets/audit-fonts', () => {
    const assets = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../assets/audit-fonts',
    );
    expect(AUDIT_FONT_FACES).toHaveLength(8);
    for (const f of AUDIT_FONT_FACES) {
      expect(fs.readFileSync(path.join(assets, f.file)).toString('base64'), f.file).toBe(
        f.woff2Base64,
      );
    }
    expect(fs.existsSync(path.join(assets, 'Literata-OFL.txt'))).toBe(true);
    expect(fs.existsSync(path.join(assets, 'GolosText-OFL.txt'))).toBe(true);
  });
});
