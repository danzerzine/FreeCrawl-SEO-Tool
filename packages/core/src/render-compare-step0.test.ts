import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectDb } from '@freecrawl/db';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import { Crawler } from './crawler.js';
import type { RenderHook } from './render-config.js';
import { fakeRender } from './fake-render.test-support.js';

// Step 0 of M11: what the render branch does today with title and noindex, no Chromium.
const pages: Record<string, string> = {};
let server: Server;
let dir: string;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fc-m11-s0-'));
  server = createServer((req, res) => {
    const html = pages[req.url ?? '/'];
    if (html === undefined) return void res.writeHead(404).end('nope');
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
async function crawl(
  path: string,
  served: string,
  hook: RenderHook | undefined,
  mode: CrawlConfig['renderingMode'] = 'js',
) {
  pages[path] = served;
  const db = new ProjectDb(join(dir, `p${n++}.seoproject`));
  const url = base + path;
  const c = new Crawler(
    {
      ...DEFAULT_CRAWL_CONFIG,
      startUrl: url,
      renderingMode: mode,
      maxConcurrency: 1,
      discoverSitemaps: false,
      checkExternalLinks: false,
      probeTlsCerts: false,
      probeManifestJson: false,
      probeSocialImages: false,
      probeImageSizes: false,
      jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender },
    },
    db,
    { renderUrl: hook },
  );
  const warns: string[] = [];
  c.on('warn', (m) => warns.push(String(m)));
  c.on('error', () => {});
  await c.start();
  const id = db.getUrlIdByUrl(url)!;
  const row = db.getUrlById(id)!;
  db.close();
  return { row, warns, url };
}

describe('render branch: title and noindex against the served HTML (M11 step 0)', () => {
  it('1. rendered title and noindex that differ from the served page are flagged as 2', async () => {
    const url = base + '/t1';
    const r = await crawl(
      '/t1',
      '<html><head><title>A</title></head><body><h1>x</h1></body></html>',
      fakeRender({
        [url]:
          '<html><head><title>B</title><meta name="robots" content="noindex"></head><body><h1>x</h1></body></html>',
      }),
    );
    expect(r.row.jsTitleChanged).toBe(2);
    expect(r.row.jsTitle).toBe('B');
    expect(r.row.jsNoindex).toBe(2);
  });

  it('2. a failed render with an error parses the served HTML, fields 0, one warn', async () => {
    const r = await crawl(
      '/t2',
      '<html><head><title>A</title></head><body></body></html>',
      fakeRender({}),
    );
    expect(r.row.title).toBe('A');
    expect(r.row.jsTitleChanged).toBe(0);
    expect(r.row.jsNoindex).toBe(0);
    expect(r.warns.filter((w) => w.includes('JS render failed'))).toHaveLength(1);
  });

  it('3. a render that navigated away keeps the served HTML, fields 0', async () => {
    const url = base + '/t3';
    const r = await crawl(
      '/t3',
      '<html><head><title>A</title></head><body></body></html>',
      fakeRender(
        { [url]: '<html><head><title>Other</title></head><body></body></html>' },
        { navigatedTo: base + '/elsewhere' },
      ),
    );
    expect(r.row.title).toBe('A');
    expect(r.row.jsTitleChanged).toBe(0);
    expect(r.row.jsNoindex).toBe(0);
  });

  it('4. text mode: an inline script that sets document.title gives 1', async () => {
    const r = await crawl(
      '/t4',
      '<html><head><title>A</title><script>document.title = \'X\';</script></head><body></body></html>',
      undefined,
      'text',
    );
    expect(r.row.jsTitleChanged).toBe(1);
  });

  it('5. a whitespace-only title difference is not a change', async () => {
    const url = base + '/t5';
    const r = await crawl(
      '/t5',
      '<html><head><title> A </title></head><body></body></html>',
      fakeRender({ [url]: '<html><head><title>A</title></head><body></body></html>' }),
    );
    expect(r.row.jsTitleChanged).toBe(0);
  });

  it('5b. a title padded with non-breaking spaces is not a change (the case that reaches the compare unnormalised)', async () => {
    // readServedHeadSignals trims before it decodes entities, so a decoded &nbsp;
    // reaches sameTitle; the space-collapsing/trim there is what makes this 0.
    const url = base + '/t5b';
    const r = await crawl(
      '/t5b',
      '<html><head><title>&nbsp;A&nbsp;</title></head><body></body></html>',
      fakeRender({ [url]: '<html><head><title>A</title></head><body></body></html>' }),
    );
    expect(r.row.jsTitleChanged).toBe(0);
  });
});
