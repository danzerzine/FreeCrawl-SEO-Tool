import { describe, expect, it } from 'vitest';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import type { BrowserPool } from './browser-pool.js';
import { runMobilePass } from './render-mobile-pass.js';

// B40 R6a: with axeAudit on the crawler clears its fetch and response-time timers (as for a page
// script), so the mobile pass needs its own limit even without a script.
function hangingPage() {
  const closers: Array<() => void> = [];
  const hang = () => new Promise<never>((_, rej) => closers.push(() => rej(new Error('Target closed'))));
  const response = { status: () => 200, statusText: () => 'OK', allHeaders: async () => ({}), url: () => 'http://x.test/', text: async () => '' };
  const page = {
    goto: async () => response,
    content: hang,
    evaluate: hang,
    screenshot: hang,
    url: () => 'http://x.test/',
    waitForTimeout: async () => {},
    waitForSelector: async () => {},
    viewportSize: () => ({ width: 1280, height: 800 }),
    setViewportSize: async () => {},
    close: async () => closers.splice(0).forEach((c) => c()),
    context: () => ({ clearCookies: async () => {} }),
  };
  const released: boolean[] = [];
  const pool = { acquire: async () => ({ page, release: (r?: boolean) => released.push(r === true) }) } as unknown as BrowserPool;
  return { pool, released };
}
const cfg = (axeAudit: boolean): CrawlConfig => ({
  ...DEFAULT_CRAWL_CONFIG,
  renderingMode: 'js',
  jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, axeAudit, mobileUsability: true },
});

describe('mobile pass limit with axe on and no page script (B40 R6a)', () => {
  it('a usability audit that hangs is cut off and the page replaced', async () => {
    const { pool, released } = hangingPage();
    const t0 = Date.now();
    const r = await runMobilePass('http://x.test/', pool, cfg(true), { limitMs: 150 });
    expect(r.usability).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(released).toEqual([true]);
  });
});
