import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { parseHtml, readServedPageSignals } from './html-parser.js';

// B159: a literal U+00A0 in served HTML comes back from Chromium's page.content() as `&nbsp;`. The rendered
// text must read the same as the served text, or js_h1_changed / js_text_changed / words differ for no reason.
const NB = '\u00a0';
const H1 = `${NB}Новости ${NB}${NB}дня${NB}`;
const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Новости</title></head><body><h1>${H1}</h1><a href="/more">Читать${NB}далее</a><p>${'слово '.repeat(60)}</p></body></html>`;
const URL_ = 'https://ex.com/';

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(Buffer.from(PAGE, 'utf8'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => server.close());

it('real Chromium: the rendered H1 and link text read the same as the served ones (B159)', async () => {
  const { chromium } = await import('playwright');
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    console.warn('SKIPPED: Chromium is not installed (', (err as Error).message, ')');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.goto(base);
    const content = await page.content();
    // The browser wrote the character back as an entity, as the test relies on.
    expect(content).toContain('&nbsp;');

    const served = parseHtml(PAGE, URL_);
    const rendered = parseHtml(content, URL_);
    expect(served.h1).toBe('Новости дня');
    expect(rendered.h1).toBe(served.h1);
    expect(readServedPageSignals(PAGE, URL_).h1).toBe(rendered.h1);
    expect(readServedPageSignals(content, URL_).h1).toBe(rendered.h1);

    const anchor = (r: ReturnType<typeof parseHtml>) => r.links.find((l) => l.toUrl.endsWith('/more'))?.anchor;
    expect(anchor(served)).toBe('Читать далее');
    expect(anchor(rendered)).toBe('Читать далее');
    expect(rendered.wordCount).toBe(served.wordCount);
  } finally {
    await browser.close();
  }
}, 60_000);
