import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';

/*
 * Answers with no Content-Length (gzip or chunked) used to get an empty
 * size. Each body below is sent without the header unless said otherwise.
 */
const css = `body { color: red; }\n${'/* padding */\n'.repeat(400)}`;
const page404 = `<html><body>${'missing '.repeat(500)}</body></html>`;
const image = Buffer.alloc(1234, 7);
// Compressed answers that do carry Content-Length: it is the compressed size.
const cssZ = gzipSync(`body { color: blue; }\n${'/* padding */\n'.repeat(900)}`);
const cssZText = `body { color: blue; }\n${'/* padding */\n'.repeat(900)}`;
const page404Z = `<html><body>${'absent '.repeat(900)}</body></html>`;
const chunks = ['a'.repeat(700), 'b'.repeat(800)];

let server: Server;
let dir: string;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'b95-'));
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/robots.txt' || url.startsWith('/sitemap')) return void res.writeHead(404).end();
    if (url === '/a.css') {
      res.writeHead(200, { 'content-type': 'text/css', 'content-encoding': 'gzip' });
      return void res.end(gzipSync(css));
    }
    if (url === '/z.css') {
      res.writeHead(200, {
        'content-type': 'text/css',
        'content-encoding': 'gzip',
        'content-length': String(cssZ.length),
      });
      return void res.end(cssZ);
    }
    if (url === '/zgone') {
      const body = gzipSync(page404Z);
      res.writeHead(404, {
        'content-type': 'text/html',
        'content-encoding': 'gzip',
        'content-length': String(body.length),
      });
      return void res.end(body);
    }
    if (url === '/gone') {
      res.writeHead(404, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      return void res.end(gzipSync(page404));
    }
    if (url === '/i.png') {
      // Unencoded with the header: the header is the size.
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(image.length) });
      return void res.end(image);
    }
    if (url === '/chunked') {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.write(chunks[0]);
      return void res.end(chunks[1]);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<html><head><title>t</title><link rel="stylesheet" href="/a.css"></head><body>' +
        // The plain link fetches the stylesheet with checkCss off too, body unread.
        '<img src="/i.png" alt="i"><a href="/gone">g</a><a href="/chunked">c</a><a href="/a.css">s</a>' +
        '<a href="/z.css">z</a><a href="/zgone">zg</a>' +
        '</body></html>',
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function sizes(name: string, checkCss: boolean): Promise<Record<string, number | null>> {
  const file = join(dir, `${name}.seoproject`);
  const db = new ProjectDb(file);
  try {
    await new Crawler(
      { ...DEFAULT_CRAWL_CONFIG, startUrl: `${base}/`, checkCss, checkImages: true, discoverSitemaps: false },
      db,
    ).start();
  } finally {
    db.close();
  }
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = raw.prepare('SELECT url, content_length AS n FROM urls').all() as { url: string; n: number | null }[];
    return Object.fromEntries(rows.map((r) => [r.url.slice(base.length), r.n]));
  } finally {
    raw.close();
  }
}

it.each([true, false])('stores the decoded size of answers without Content-Length (checkCss %s)', async (checkCss) => {
  const got = await sizes(`css-${checkCss}`, checkCss);
  expect(got['/a.css']).toBe(Buffer.byteLength(css));
  expect(got['/gone']).toBe(Buffer.byteLength(page404));
  expect(got['/chunked']).toBe(chunks.join('').length);
  expect(got['/i.png']).toBe(image.length);
});

it.each([true, false])(
  'stores the decoded size, not the Content-Length, of a compressed answer (checkCss %s)',
  async (checkCss) => {
    const got = await sizes(`z-${checkCss}`, checkCss);
    expect(cssZ.length).toBeLessThan(Buffer.byteLength(cssZText) / 2);
    expect(got['/z.css']).toBe(Buffer.byteLength(cssZText));
    expect(got['/zgone']).toBe(Buffer.byteLength(page404Z));
  },
);
