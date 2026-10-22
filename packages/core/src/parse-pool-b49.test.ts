import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { extractProseText, parseHtml } from './html-parser.js';
import { ParserPool, poolParseHtml } from './parse-pool.js';

// The built worker (`npx tsc -b` first): a `.ts` worker does not load in a thread.
const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/parse-worker.js');
const PAGE = 'https://example.com/shop/item?id=7';

const PAGES = [
  `<!doctype html><html lang="ru"><head><title>Привет, мир 🚀</title>
   <meta name="description" content="Описание"><meta name="robots" content="noindex, follow">
   <link rel="canonical" href="/shop/item"><link rel="alternate" hreflang="en" href="https://example.com/en/">
   <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"X",
   "offers":{"@type":"Offer","price":"10","priceCurrency":"EUR"}}</script></head>
   <body><header><nav><a href="/">Home</a></nav></header><main><h1>Item</h1><h2>Details</h2>
   <p>${'Текст страницы. '.repeat(200)}</p><img src="/a.png" alt="a" width="10" height="10">
   <a href="https://other.example/x" rel="nofollow">ext</a><a href="/shop/item?id=8">next</a></main>
   <footer>© 2026</footer></body></html>`,
  '<html><body><h1></h1><a href="javascript:void(0)">x</a><a href="#top">top</a></body></html>',
  '<p>no head at all',
];

let pool: ParserPool | null = null;
afterEach(async () => {
  await pool?.terminate();
  pool = null;
});

describe('ParserPool (B49)', () => {
  it('returns what the inline parser returns', async () => {
    pool = new ParserPool(WORKER);
    pool.init(2);
    expect(await pool.whenReady()).toBe(true);
    for (const html of PAGES) {
      expect(await pool.parse(html, PAGE, { contentAreaSelector: 'main' })).toEqual(
        parseHtml(html, PAGE, { contentAreaSelector: 'main' }),
      );
    }
    expect(await pool.prose(PAGES[0]!, 'main')).toBe(extractProseText(PAGES[0]!, 'main'));
    expect(pool.parsed).toBe(PAGES.length + 1);
  });

  it('is not ready when the worker file does not load, and parses inline', async () => {
    const log: string[] = [];
    pool = new ParserPool(path.join(path.dirname(WORKER), 'no-such-worker.js'), (_l, m) => log.push(m));
    pool.init(2);
    expect(await pool.whenReady()).toBe(false);
    expect(pool.isReady()).toBe(false);
    const parse = poolParseHtml(pool);
    expect(await parse(PAGES[1]!, PAGE, {})).toEqual(parseHtml(PAGES[1]!, PAGE, {}));
    expect(pool.parsed).toBe(0);
    // Each worker gives up once; none is respawned.
    expect(log.filter((m) => m.includes('failed to start'))).toHaveLength(2);
  });
});
