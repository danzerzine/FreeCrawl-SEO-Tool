import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import { parseHtml } from './html-parser.js';

const TEXT = 'Some words of the page itself. '.repeat(20);
const doc = (head: string, body: string) => `<html><head>${head}</head><body>${body}${TEXT}</body></html>`;
const HEAD = '<title>Head title of the page</title><meta name="description" content="Head description of the page">';

describe('title, description and meta robots inside <body> (B26)', () => {
  const parse = (html: string) => parseHtml(html, 'https://ex.test/', { robotsBot: 'googlebot' });

  it('a tag only in body is read and counted', () => {
    const p = parse(
      doc('', '<title>Body title</title><meta name="description" content="Body description"><meta name="robots" content="noindex">'),
    );
    expect(p).toMatchObject({ title: 'Body title', metaDescription: 'Body description', hasNoindex: true });
    expect([p.titleOutsideHead, p.descriptionOutsideHead, p.metaRobotsOutsideHead]).toEqual([1, 1, 1]);
  });

  it('a copy in body is counted; the head value wins', () => {
    const p = parse(doc(HEAD, '<title>Body title</title><meta name="description" content="Body description">'));
    expect(p).toMatchObject({ title: 'Head title of the page', metaDescription: 'Head description of the page' });
    expect([p.titleOutsideHead, p.descriptionOutsideHead, p.metaRobotsOutsideHead]).toEqual([1, 1, 0]);
  });

  it('a page with them in head counts none; an svg title in body is not a page title', () => {
    const p = parse(doc(`${HEAD}<meta name="robots" content="index">`, '<svg><title>Icon</title></svg>'));
    expect([p.titleOutsideHead, p.descriptionOutsideHead, p.metaRobotsOutsideHead]).toEqual([0, 0, 0]);
  });
});

let server: Server;
let dir: string;
let base: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b26-'));
  server = createServer((req, res) => {
    const pages: Record<string, string> = {
      '/': doc(HEAD, '<a href="/title">t</a><a href="/desc">d</a><a href="/robots">r</a>'),
      '/title': doc('<meta name="description" content="Head description of the page">', '<title>Body title of the page</title>'),
      '/desc': doc('<title>Head title of the page</title>', '<meta name="description" content="Body description">'),
      '/robots': doc(HEAD, '<meta name="robots" content="noindex">'),
    };
    const body = pages[req.url ?? ''];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

it('a crawl lists each page under its own check; a body noindex still applies (B26)', async () => {
  const db = new ProjectDb(join(dir, 'p.seoproject'));
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: base,
      maxConcurrency: 2,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
    },
    db,
  );
  c.on('error', () => {});
  await c.start();
  const list = (category: 'issues:title-outside-head' | 'issues:description-outside-head' | 'issues:meta-robots-outside-head') =>
    db.queryUrls({ limit: 10, offset: 0, category }).rows.map((r) => r.url.slice(base.length));
  expect(list('issues:title-outside-head')).toEqual(['title']);
  expect(list('issues:description-outside-head')).toEqual(['desc']);
  expect(list('issues:meta-robots-outside-head')).toEqual(['robots']);
  const { titleOutsideHead, descriptionOutsideHead, metaRobotsOutsideHead } = db.getOverviewCounts().issues;
  expect([titleOutsideHead, descriptionOutsideHead, metaRobotsOutsideHead]).toEqual([1, 1, 1]);
  const id = db.getUrlIdByUrl(`${base}robots`);
  expect(db.getUrlById(id!)?.indexability).toBe('non-indexable:noindex');
  db.close();
}, 30_000);
