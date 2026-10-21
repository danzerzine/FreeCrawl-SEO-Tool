import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { parseHtml } from './html-parser.js';

/*
 * B98 lifecycle: which run may learn a template set, and that every
 * fingerprinted row ends on the project's current set across refresh,
 * Re-Spider, stop + resume, pause, a reset to a new site, and the writer
 * running on its own connection (the desktop writer worker).
 *
 * Site A at /: 60 articles /a0..a59 (+ /cal/2026-01-DD date pages when
 * `calendar` is on). Site B at /b/: 60 articles with another teaser.
 */
let server: Server;
let dir: string;
let base: string;
let calendar = false;
const words = (seed: string, n: number) => Array.from({ length: n }, (_, i) => `${seed}w${i}`).join(' ');
const teaser = (seed: string) => Array.from({ length: 300 }, (_, i) => `${seed}${i % 97} issue${i}`).join(' ');
const article = (title: string, body: string, t: string) =>
  `<html><head><title>${title} with a long enough title</title></head><body>` +
  `<div class="article"><p>${body}</p><aside>${t}</aside></div></body></html>`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b98-life-'));
  server = createServer((req, res) => {
    const url = req.url ?? '';
    const ok = (html: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    const home = (prefix: string) => {
      const links = Array.from({ length: 60 }, (_, i) => `<a href="${prefix}a${i}">${i}</a>`);
      if (calendar && prefix === '/') {
        for (let d = 1; d <= 25; d++) links.push(`<a href="/cal/2026-01-${String(d).padStart(2, '0')}">${d}</a>`);
      }
      return ok(`<html><head><title>Home page of the test site</title></head><body>${links.join('')}</body></html>`);
    };
    if (url === '/') return home('/');
    if (url === '/b/') return home('/b/');
    let m = /^\/a(\d+)$/.exec(url);
    if (m) return ok(article(`A${m[1]}`, words(`pa${m[1]}`, 150), teaser('ta')));
    m = /^\/b\/a(\d+)$/.exec(url);
    if (m) return ok(article(`B${m[1]}`, words(`pb${m[1]}`, 150), teaser('tb')));
    m = /^\/cal\/2026-01-(\d+)$/.exec(url);
    // A date page: the teaser and the day — nearly all template text.
    if (m) return ok(article(`Day ${m[1]}`, words(`day${m[1]}x`, 8), teaser("ta")));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

let file: string;
let n = 0;
beforeEach(() => {
  calendar = false;
  file = join(dir, `p${n++}.seoproject`);
});

const config = (over: Partial<CrawlConfig> = {}): CrawlConfig => ({
  ...DEFAULT_CRAWL_CONFIG,
  startUrl: `${base}/`,
  maxConcurrency: 4,
  discoverSitemaps: false,
  checkExternalLinks: false,
  probeTlsCerts: false,
  probeManifestJson: false,
  probeSocialImages: false,
  probeImageSizes: false,
  contentAreaSelector: '.article',
  ...over,
});
type Opts = ConstructorParameters<typeof Crawler>[2];
async function crawl(db: ProjectDb, over: Partial<CrawlConfig> = {}, opts: Opts = {}, during?: (c: Crawler) => void) {
  const c = new Crawler(config(over), db, opts);
  c.on('error', () => {});
  during?.(c);
  await c.start();
  return c;
}
/** Writer on its own connection, as the desktop writer worker. */
function writerOn(writer: ProjectDb): Opts {
  return {
    writeFetchedUrl: (p) => Promise.resolve(writer.writeFetchedUrl(p)),
    dbCall: <T,>(method: string, args: unknown[]) =>
      Promise.resolve((writer as unknown as Record<string, (...a: unknown[]) => T>)[method]!(...args)),
    runDbPass: (method) => {
      (writer as unknown as Record<string, () => void>)[method]!();
      return Promise.resolve();
    },
  };
}
function state(db: ProjectDb) {
  const raw = new DatabaseSync(file);
  const rows = raw
    .prepare(`SELECT url, template_set_id AS "set", url_trap AS trap FROM urls WHERE simhash IS NOT NULL OR minhash IS NOT NULL`)
    .all() as { url: string; set: number | null; trap: string | null }[];
  const traps = (raw.prepare(`SELECT COUNT(*) AS n FROM urls WHERE url_trap = 'calendar'`).get() as { n: number }).n;
  raw.close();
  const id = db.getMeta('templateSetId');
  return {
    setId: id === null ? null : Number(id),
    learn: db.getMeta('templateLearn'),
    notCompared: db.getMeta('nearDuplicateNotCompared'),
    rows,
    ids: [...new Set(rows.map((r) => r.set))],
    traps,
  };
}

describe('right to learn (B98)', () => {
  it('a project whose rows have no fingerprint does not learn on refresh or Re-Spider', async () => {
    const db = new ProjectDb(file);
    await crawl(db, { contentAreaSelector: '.missing' }); // every page selector-missed
    expect(state(db).setId).toBeNull();
    await crawl(db); // same-site refresh, now with fingerprints
    let s = state(db);
    expect(s.rows.length).toBe(60);
    expect(s.setId).toBeNull();
    expect(s.ids).toEqual([null]);
    await crawl(db, {}, { respiderSeeds: [`${base}/a1`, `${base}/a2`, `${base}/a3`] });
    s = state(db);
    expect(s.setId).toBeNull();
    expect(s.ids).toEqual([null]);
    expect(s.notCompared).toBe('0');
    db.close();
  }, 60_000);

  it('a frozen set survives a refresh stopped halfway and a Re-Spider of 3 pages', async () => {
    const db = new ProjectDb(file);
    await crawl(db);
    const first = state(db);
    expect(first.setId).not.toBeNull();
    expect(first.ids).toEqual([first.setId]);
    let writes = 0;
    await crawl(db, {}, {
      writeFetchedUrl: (p) => {
        const r = db.writeFetchedUrl(p);
        if (++writes === 30) stopper?.stop();
        return Promise.resolve(r);
      },
    }, (c) => (stopper = c));
    let s = state(db);
    expect(s.setId).toBe(first.setId);
    expect(s.ids).toEqual([first.setId]);
    await crawl(db, {}, { respiderSeeds: [`${base}/a1`, `${base}/a2`, `${base}/a3`] });
    s = state(db);
    expect(s.setId).toBe(first.setId);
    expect(s.ids).toEqual([first.setId]);
    expect(s.learn).toBe('0');
    db.close();
  }, 60_000);

  it('a run stopped while learning leaves the flag at 0 and its resume does not learn', async () => {
    const db = new ProjectDb(file);
    let writes = 0;
    await crawl(db, {}, {
      writeFetchedUrl: (p) => {
        const r = db.writeFetchedUrl(p);
        if (++writes === 10) stopper?.stop();
        return Promise.resolve(r);
      },
    }, (c) => (stopper = c));
    expect(state(db).learn).toBe('0');
    await crawl(db, {}, { resumeOnly: true });
    const s = state(db);
    expect(s.rows.length).toBe(60);
    expect(s.setId).toBeNull();
    expect(s.ids).toEqual([null]);
    db.close();
  }, 60_000);

  it('a templateLearn flag left at 1 by a killed run does not make the resume sample', async () => {
    const db = new ProjectDb(file);
    let writes = 0;
    await crawl(db, {}, {
      writeFetchedUrl: (p) => {
        const r = db.writeFetchedUrl(p);
        if (++writes === 10) stopper?.stop();
        return Promise.resolve(r);
      },
    }, (c) => (stopper = c));
    db.setMeta('templateLearn', '1'); // the run was killed before it cleared the flag
    await crawl(db, {}, { resumeOnly: true });
    const s = state(db);
    expect(s.rows.length).toBe(60);
    expect(s.setId).toBeNull();
    expect(s.ids).toEqual([null]);
    expect(s.learn).toBe('0');
    db.close();
  }, 60_000);

  for (const writer of ['writer connection', 'main connection'] as const) {
    it(`a different-site start resets and learns a new set; no row keeps the old id (${writer})`, async () => {
      const db = new ProjectDb(file);
      const w = writer === 'writer connection' ? new ProjectDb(file) : db;
      const opts = writer === 'writer connection' ? writerOn(w) : {};
      await crawl(db, {}, opts);
      const old = state(db).setId;
      expect(old).not.toBeNull();
      await crawl(db, { startUrl: `${base}/b/` }, opts);
      const s = state(db);
      expect(s.setId).not.toBeNull();
      expect(s.setId).not.toBe(old);
      expect(s.rows.every((r) => r.url.startsWith(`${base}/b/`))).toBe(true);
      expect(s.ids).toEqual([s.setId]);
      expect(s.notCompared).toBe('0');
      if (w !== db) w.close();
      db.close();
    }, 60_000);
  }
});

let stopper: Crawler | undefined;

describe('pause and the calendar trap with a set (B98)', () => {
  it('a sample page parsing when the crawl is paused ends on the current set', async () => {
    const db = new ProjectDb(file);
    let crawler: Crawler | undefined;
    let paused = false;
    await crawl(
      db,
      {},
      {
        parseHtml: async (html, url, o) => {
          if (url === `${base}/a5` && !paused) {
            paused = true;
            crawler!.pause();
            setTimeout(() => crawler!.resume(), 300);
            await new Promise((r) => setTimeout(r, 100));
          }
          return parseHtml(html, url, o);
        },
      },
      (c) => (crawler = c),
    );
    const s = state(db);
    expect(paused).toBe(true);
    expect(s.rows.length).toBe(60);
    expect(s.setId).not.toBeNull();
    expect(s.ids).toEqual([s.setId]);
    expect(s.notCompared).toBe('0');
    db.close();
  }, 60_000);

  it('date pages that are all template text are still caught as a calendar trap on a refresh with the set', async () => {
    const db = new ProjectDb(file);
    await crawl(db);
    expect(state(db).setId).not.toBeNull();
    calendar = true;
    await crawl(db); // refresh: parses with the stored set
    expect(state(db).traps).toBeGreaterThanOrEqual(20);
    db.close();
  }, 60_000);
});
