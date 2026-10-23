import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'b90-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const baseConfig = (startUrl: string): CrawlConfig => ({
  ...DEFAULT_CRAWL_CONFIG,
  startUrl,
  maxConcurrency: 2,
  maxRps: 0,
  discoverSitemaps: false,
  checkExternalLinks: false,
  probeTlsCerts: false,
  probeManifestJson: false,
  probeSocialImages: false,
  probeImageSizes: false,
});

const quiet = (c: Crawler): Crawler => {
  c.on('error', () => {});
  return c;
};

describe('requeueKnown: one place drops a URL from seen', () => {
  it('seen.delete( appears only inside requeueKnown', () => {
    const src = readFileSync(new URL('./crawler.ts', import.meta.url), 'utf8');
    const lines = src.split('\n');
    const at = lines.flatMap((l, i) => (l.includes('seen.delete(') ? [i] : []));
    expect(at).toHaveLength(1);
    const start = lines.findIndex((l) => /\brequeueKnown\(/.test(l) && /^\s*(private )?requeueKnown\(/.test(l));
    expect(start).toBeGreaterThan(-1);
    expect(at[0]!).toBeGreaterThan(start);
    expect(at[0]! - start).toBeLessThan(12);
  });
});

describe('counts are the same for fresh, refresh, resume and re-spider', () => {
  let server: Server;
  let base: string;
  let requests = 0;
  let onRequest: ((n: number) => void) | null = null;

  const page = (body: string): string =>
    `<html><head><title>T ${body.length} page title long enough</title><link rel="stylesheet" href="/s.css"><script src="/a.js"></script></head><body><img src="/i.png" alt="x">${body}</body></html>`;

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests++;
      const url = req.url ?? '/';
      const path = url.split('?')[0]!;
      const html = (s: string): void => {
        res.writeHead(200, { 'content-type': 'text/html' }).end(page(s));
        onRequest?.(requests);
      };
      if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /blocked/\n');
      if (path === '/s.css') return void res.writeHead(200, { 'content-type': 'text/css' }).end('@font-face{font-family:x;src:url(/f.woff2)} body{color:#222}');
      if (path === '/a.js') return void res.writeHead(200, { 'content-type': 'application/javascript' }).end('var a=1;');
      if (path === '/f.woff2') return void res.writeHead(200, { 'content-type': 'font/woff2' }).end(Buffer.alloc(64));
      if (path === '/i.png') return void res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
      if (path === '/doc.pdf') return void res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.4 tiny');
      if (path === '/r') return void res.writeHead(301, { location: '/s1/p1' }).end();
      if (path === '/') {
        const links: string[] = ['/doc.pdf', '/r', '/blocked/x'];
        for (let s = 1; s <= 3; s++) for (let p = 1; p <= 12; p++) links.push(`/s${s}/p${p}`);
        for (let i = 0; i < 30; i++) links.push(`/shop?color=c${i % 6}&size=s${i % 5}&n=${i}`);
        return html(links.map((l) => `<a href="${l}">${l}</a>`).join(' '));
      }
      html(`<p>${url} ${'word '.repeat(60)}</p>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => void server.close());

  const watchState = (c: Crawler) => {
    const w = c.trapWatch;
    return {
      n: w.discovered,
      sizes: w.tableSizes(),
      shop: w.patternCount(`127.0.0.1:${new URL(base).port}?color,n,size`),
    };
  };
  const run = async (db: ProjectDb, opts: ConstructorParameters<typeof Crawler>[2] = {}) => {
    const c = quiet(new Crawler(baseConfig(`${base}/`), db, opts));
    await c.start();
    return c;
  };

  it('a stored page counts once however the project is walked again', async () => {
    const db = new ProjectDb(join(dir, 'a.seoproject'));
    const fresh = watchState(await run(db));
    // 1 home + pdf + redirect + 36 pages + 30 facet pages; css/js/img/font and the robots-blocked URL are not pages
    expect(fresh.n).toBe(1 + 1 + 1 + 36 + 30);
    expect(fresh.shop).toBe(30);

    const refreshed = watchState(await run(db));
    expect(refreshed).toEqual(fresh);

    const one = watchState(await run(db, { respiderSeeds: [`${base}/s1/p2`] }));
    expect(one).toEqual(fresh);
    const sel = Array.from({ length: 30 }, (_, i) => `${base}/shop?color=c${i % 6}&size=s${i % 5}&n=${i}`);
    expect(watchState(await run(db, { respiderSeeds: sel }))).toEqual(fresh);
    db.close();
  }, 60_000);

  it('stop in the middle and resume ends with the same counts, queued URLs included', async () => {
    const db = new ProjectDb(join(dir, 'b.seoproject'));
    const c1 = quiet(new Crawler(baseConfig(`${base}/`), db));
    onRequest = (n) => {
      if (n === requests && stopAt !== 0 && n >= stopAt) {
        stopAt = 0;
        void c1.saveQueueCheckpoint().then(() => c1.stop());
      }
    };
    let stopAt = requests + 12;
    await c1.start();
    onRequest = null;
    expect(db.loadUnfetchedQueueCheckpoint().length).toBeGreaterThan(10);
    const c2 = quiet(new Crawler(baseConfig(`${base}/`), db, { resumeOnly: true }));
    c2.enqueueCheckpointed(db.loadUnfetchedQueueCheckpoint());
    await c2.start();
    const resumed = watchState(c2);
    expect(resumed.n).toBe(1 + 1 + 1 + 36 + 30);
    expect(resumed.shop).toBe(30);
    db.close();
  }, 60_000);
});

describe('a faceted shop trap on a local server', () => {
  let server: Server;
  let base: string;
  const POOL = 15_000;
  const floors = { r2Count: 300, r3Count: 600, r1Count: 600, checkEvery: 100 };

  const SORTS = ['asc', 'desc', 'new'];
  /** i -> color (10) x size (10) x sort (3) x page (50) = 15 000 distinct pages. */
  const facetUrl = (i: number): string => {
    const page = (i % 50) + 1;
    const rest = Math.floor(i / 50);
    const o = rest % 3;
    const cs = Math.floor(rest / 3);
    return `/shop/list?color=c${Math.floor(cs / 10)}&size=s${cs % 10}&sort=${SORTS[o]}&page=${page}`;
  };
  const indexOf = (u: URL): number => {
    const c = Number(u.searchParams.get('color')!.slice(1));
    const s = Number(u.searchParams.get('size')!.slice(1));
    const o = SORTS.indexOf(u.searchParams.get('sort')!);
    return ((c * 10 + s) * 3 + o) * 50 + (Number(u.searchParams.get('page')) - 1);
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const html = (b: string, t = u.pathname): void =>
        void res
          .writeHead(200, { 'content-type': 'text/html' })
          .end(`<html><head><title>${t} page title long enough</title></head><body>${b}</body></html>`);
      if (u.pathname === '/robots.txt') return void res.writeHead(404).end();
      if (u.pathname === '/sitemap.xml') {
        const loc = Array.from({ length: 40 }, (_, i) => `<url><loc>http://${req.headers.host}/p/${i}</loc></url>`).join('');
        return void res
          .writeHead(200, { 'content-type': 'application/xml' })
          .end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${loc}</urlset>`);
      }
      if (u.pathname === '/') {
        const links = ['/shop/list?color=c0&size=s0&sort=asc&page=1', ...Array.from({ length: 40 }, (_, i) => `/p/${i}`)];
        return html(links.map((l) => `<a href="${l}">x</a>`).join(' '));
      }
      if (u.pathname.startsWith('/p/')) return html(`<p>${'article '.repeat(40)}${u.pathname}</p>`);
      if (u.pathname === '/shop/list') {
        const i = indexOf(u);
        const next = [1, 7, 53, 211, 997].map((d) => (i + d) % POOL);
        const text = Array.from({ length: 30 }, (_, k) => `w${(i * 31 + k * 17) % 9973}`).join(' ');
        return html(`<p>${text}</p>` + next.map((n) => `<a href="${facetUrl(n)}">f</a>`).join(' '), `shop ${i}`);
      }
      if (u.pathname.startsWith('/tiny')) return html('<p>tiny site for a fresh crawl</p>');
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => void server.close());

  const crawler = (db: ProjectDb, over: Partial<CrawlConfig> = {}, opts: ConstructorParameters<typeof Crawler>[2] = {}) =>
    quiet(
      new Crawler(
        { ...baseConfig(`${base}/`), maxConcurrency: 8, maxRps: 0, maxDepth: 100, maxUrls: 3000, discoverSitemaps: true, ...over },
        db,
        { trapWatch: { floors }, ...opts },
      ),
    );
  const traps = (db: ProjectDb) => db.getOverviewCounts().site?.crawlTraps ?? [];
  const trapWarns = (c: Crawler): string[] => {
    const out: string[] = [];
    c.on('warn', (m: string) => /Possible crawl trap/.test(m) && out.push(m));
    return out;
  };

  it('warns once for the faceted pattern, the crawl ends only at maxUrls, project and overview hold the finding', async () => {
    const db = new ProjectDb(join(dir, 't1.seoproject'));
    const c = crawler(db);
    const warns = trapWarns(c);
    const infos: string[] = [];
    c.on('info', (m: string) => infos.push(m));
    await c.start();
    const pattern = warns.filter((m) => m.includes('share the pattern'));
    expect(pattern).toHaveLength(1);
    expect(pattern[0]!).toMatch(/Possible crawl trap: \d+ URLs share the pattern .*\?color&page&size&sort \(\d+ % of the [\d,]+ found so far\); the sitemap lists 0 of them and 40 pages in total\. The crawl goes on\./);
    expect(db.getOverviewCounts().site?.crawlStoppedAtLimit).toBe(3000);
    const found = traps(db);
    expect(found.map((f) => f.rule).sort()).toEqual(expect.arrayContaining(['R2']));
    const r2 = found.find((f) => f.rule === 'R2')!;
    expect(r2).toMatchObject({ expected: 0 });
    expect(r2.samples).toHaveLength(3);
    for (const u of r2.samples) expect(u.startsWith(base)).toBe(true);
    expect(r2.count).toBeGreaterThan(2000);
    expect(JSON.parse(db.getMeta('crawlTrapWatch')!)).toMatchObject({ v: 1, sitemapUrls: 40 });
    // R1 is an info line only: 3000 pages against 40 sitemap URLs
    expect(infos.some((m) => /the sitemap lists 40;/.test(m))).toBe(true);
    expect(found.every((f) => f.rule !== ('R1' as string))).toBe(true);
    db.close();
  }, 120_000);

  it('keeps the finding through a stop and resume without warning again for it, and a fresh crawl clears it', async () => {
    const db = new ProjectDb(join(dir, 't2.seoproject'));
    const c1 = crawler(db);
    let stopped = false;
    const first: string[] = [];
    c1.on('warn', (m: string) => {
      if (!/Possible crawl trap/.test(m)) return;
      first.push(m);
      if (!stopped) {
        stopped = true;
        void c1.saveQueueCheckpoint().then(() => c1.stop());
      }
    });
    await c1.start();
    const atStop = traps(db);
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(atStop.length).toBeGreaterThanOrEqual(1);

    const c2 = crawler(db, {}, { resumeOnly: true });
    const again = trapWarns(c2);
    c2.enqueueCheckpointed(db.loadUnfetchedQueueCheckpoint());
    await c2.start();
    expect(again.filter((m) => m.includes('share the pattern'))).toEqual([]);
    const after = traps(db);
    for (const f of atStop) expect(after.map((x) => x.key)).toContain(f.key);
    expect(after.find((f) => f.rule === 'R2')!.count).toBeGreaterThan(atStop.find((f) => f.rule === 'R2')!.count);

    const c3 = quiet(new Crawler({ ...baseConfig(`${base}/tiny`), discoverSitemaps: false }, db));
    await c3.start();
    expect(traps(db)).toEqual([]);
    db.close();
  }, 120_000);
});

describe('normal sites stay quiet on a real crawl', () => {
  let server: Server;
  let base: string;
  const floors = { r2Count: 300, r3Count: 600, r1Count: 600, checkEvery: 100 };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const html = (b: string): void =>
        void res
          .writeHead(200, { 'content-type': 'text/html' })
          .end(`<html><head><title>${u.pathname}${u.search} title long enough</title></head><body>${b}</body></html>`);
      const words = (seed: string): string => Array.from({ length: 30 }, (_, k) => `${seed}${k * 7}`).join(' ');
      if (u.pathname === '/robots.txt' || u.pathname === '/sitemap.xml') return void res.writeHead(404).end();
      if (u.pathname === '/') {
        const links = [
          ...Array.from({ length: 400 }, (_, i) => `/blog/post-${i}`),
          ...Array.from({ length: 40 }, (_, i) => `/archive?page=${i + 1}`),
          ...Array.from({ length: 20 }, (_, i) => `/tag/t${i}`),
          '/forum/viewforum.php?f=1',
        ];
        return html(links.map((l) => `<a href="${l}">x</a>`).join(' '));
      }
      if (u.pathname === '/forum/viewforum.php') {
        return html(Array.from({ length: 1200 }, (_, i) => `<a href="/forum/viewtopic.php?t=${i + 1}">t</a>`).join(' '));
      }
      html(`<p>${words(u.pathname + u.search)}</p>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => void server.close());

  it('a blog with archive pages and tags, and a forum with viewtopic.php?t=N, give no finding', async () => {
    const db = new ProjectDb(join(dir, 'n.seoproject'));
    const c = quiet(
      new Crawler({ ...baseConfig(`${base}/`), maxConcurrency: 8, maxRps: 0, maxDepth: 100 }, db, {
        trapWatch: { floors },
      }),
    );
    const warns: string[] = [];
    c.on('warn', (m: string) => /Possible crawl trap/.test(m) && warns.push(m));
    await c.start();
    expect(c.trapWatch.discovered).toBeGreaterThan(1600);
    expect(warns).toEqual([]);
    expect(db.getOverviewCounts().site?.crawlTraps).toEqual([]);
    db.close();
  }, 120_000);
});

describe('what is not a page of the site is not counted', () => {
  let server: Server;
  let base: string;
  let ext: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const html = (b: string): void =>
        void res
          .writeHead(200, { 'content-type': 'text/html' })
          .end(`<html><head><title>${u.pathname} title long enough</title></head><body>${b}</body></html>`);
      if (u.pathname === '/robots.txt' || u.pathname === '/sitemap.xml') return void res.writeHead(404).end();
      if (u.pathname === '/') {
        const links = [
          ...Array.from({ length: 20 }, (_, i) => `<a href="/p/${i}">p</a>`),
          ...Array.from({ length: 300 }, (_, i) => `<a href="${ext}/x/${i}">x</a>`),
        ];
        return html(links.join(' '));
      }
      html(`<p>${u.pathname} text</p>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
    ext = `http://localhost:${port}`; // another host name for the same server
  });
  afterAll(() => void server.close());

  it('with crawlExternal on, pages of another host are crawled but not counted', async () => {
    const db = new ProjectDb(join(dir, 'x.seoproject'));
    const c = quiet(
      new Crawler(
        { ...baseConfig(`${base}/`), maxRps: 0, crawlExternal: true, checkExternalLinks: true },
        db,
      ),
    );
    await c.start();
    expect(c.trapWatch.discovered).toBe(21);
    db.close();
  }, 60_000);
});

describe('a refresh of a stored project does not count what is not a page', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/sitemap.xml') {
        const loc = Array.from({ length: 600 }, (_, i) => `<url><loc>http://${req.headers.host}/p/${i}</loc></url>`).join('');
        return void res
          .writeHead(200, { 'content-type': 'application/xml' })
          .end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${loc}</urlset>`);
      }
      if (u.pathname.startsWith('/wp-content/')) return void res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
      if (u.pathname === '/robots.txt' || u.pathname === '/sitemap_index.xml') return void res.writeHead(404).end();
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(`<html><head><title>${u.pathname} title long enough</title></head><body><p>${u.pathname} text</p></body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => void server.close());

  it('3 000 pages, a 600-URL sitemap and 6 000 stored images: no R2, no R3, no image counted', async () => {
    const file = join(dir, 'w.seoproject');
    new ProjectDb(file).close();
    const raw = new DatabaseSync(file);
    raw.exec('BEGIN');
    const ins = raw.prepare(
      'INSERT INTO urls (url, is_external, content_kind, status_code, depth) VALUES (?, 0, ?, 200, 1)',
    );
    ins.run(`${base}/`, 'html');
    for (let i = 0; i < 3000; i++) ins.run(`${base}/p/${i}`, 'html');
    for (let i = 0; i < 6000; i++) ins.run(`${base}/wp-content/uploads/i${i}.png`, 'image');
    raw.exec('COMMIT');
    raw.close();
    const db = new ProjectDb(file);
    db.setMeta('startUrl', `${base}/`);
    const c = quiet(new Crawler({ ...baseConfig(`${base}/`), maxConcurrency: 8, maxRps: 0, discoverSitemaps: true }, db));
    const warns: string[] = [];
    c.on('warn', (m: string) => /Possible crawl trap/.test(m) && warns.push(m));
    await c.start();
    expect(c.trapWatch.sitemapUrls).toBe(600);
    expect(c.trapWatch.discovered).toBe(3001);
    expect(warns).toEqual([]);
    expect(db.getOverviewCounts().site?.crawlTraps).toEqual([]);
    db.close();
  }, 180_000);
});
