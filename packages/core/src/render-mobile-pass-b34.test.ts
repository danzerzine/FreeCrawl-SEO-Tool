import { describe, expect, it } from 'vitest';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import type { BrowserPool } from './browser-pool.js';
import { runMobilePass } from './render-mobile-pass.js';

// M11 B34 (spec R2-1): the desktop mobile pass has its own time limit when a page
// script is set, because the crawler then clears the fetch and response-time timers.

/** A page whose evaluate and content never answer on their own; close() rejects them, like Chromium. */
function hangingPage() {
  const closers: Array<() => void> = [];
  const hang = () => new Promise<never>((_, rej) => closers.push(() => rej(new Error('Target closed'))));
  const response = {
    status: () => 200,
    statusText: () => 'OK',
    allHeaders: async () => ({}),
    url: () => 'http://x.test/',
    text: async () => '<html></html>',
  };
  const page = {
    closed: false,
    goto: async () => response,
    content: hang,
    evaluate: hang,
    screenshot: hang,
    url: () => 'http://x.test/',
    waitForTimeout: async () => {},
    waitForSelector: async () => {},
    viewportSize: () => ({ width: 1280, height: 800 }),
    setViewportSize: async () => {},
    close: async () => {
      page.closed = true;
      closers.splice(0).forEach((c) => c());
    },
    context: () => ({ clearCookies: async () => {} }),
  };
  const released: boolean[] = [];
  const pool = {
    acquire: async () => ({ page, release: (r?: boolean) => released.push(r === true) }),
  } as unknown as BrowserPool;
  return { pool, released, page };
}

const cfg = (pageScript: string, over: Partial<CrawlConfig['jsRender']> = {}): CrawlConfig => ({
  ...DEFAULT_CRAWL_CONFIG,
  renderingMode: 'js',
  jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, pageScript, mobileUsability: true, ...over },
});

describe('desktop mobile pass limit (B34 R2-1)', () => {
  it('a usability audit that hangs is cut off, page replaced, when a page script is set', async () => {
    const { pool, released } = hangingPage();
    const t0 = Date.now();
    const r = await runMobilePass('http://x.test/', pool, cfg('return 1'), { limitMs: 150 });
    expect(r.usability).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(released).toEqual([true]);
  });

  it('a mobile screenshot render that hangs is cut off too', async () => {
    const { pool, released } = hangingPage();
    const t0 = Date.now();
    const r = await runMobilePass(
      'http://x.test/',
      pool,
      cfg('return 1', { mobileUsability: false, mobileScreenshot: true }),
      { limitMs: 150, screenshotPath: '/tmp/never.png' },
    );
    expect(r.screenshotPath).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(released).toEqual([true]);
  });
});
