import { describe, expect, it } from 'vitest';
import type { BrowserPool } from './browser-pool.js';
import { renderUrl } from './render-fetcher.js';

// A fake pool and page: renderUrl without Chromium (M11 B33 step 0b).
function fakePool(responseText: () => Promise<string>): BrowserPool {
  const response = {
    status: () => 200,
    statusText: () => 'OK',
    allHeaders: async () => ({}),
    url: () => 'http://x.test/',
    text: responseText,
  };
  const page = {
    goto: async () => response,
    content: async () => '<html><body>rendered</body></html>',
    evaluate: async () => 'http://x.test/',
    url: () => 'http://x.test/',
    waitForTimeout: async () => {},
    waitForSelector: async () => {},
    viewportSize: () => null,
    close: async () => {},
    context: () => ({ clearCookies: async () => {} }),
  };
  return { acquire: async () => ({ page, release: () => {} }) } as unknown as BrowserPool;
}

const opts = { timeoutMs: 1000, ajaxTimeoutMs: 0, waitUntil: 'load' as const };

describe('renderUrl served HTML (B33 step 0b)', () => {
  it('returns the browser main-document response body as servedHtml', async () => {
    const r = await renderUrl('http://x.test/', fakePool(async () => '<html>served</html>'), opts);
    expect(r.ok).toBe(true);
    expect(r.servedHtml).toBe('<html>served</html>');
  });

  it('counts a response.text() that throws as absent: render ok, servedHtml unset', async () => {
    const r = await renderUrl(
      'http://x.test/',
      fakePool(async () => {
        throw new Error('No resource with given identifier found');
      }),
      opts,
    );
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.servedHtml).toBeUndefined();
  });
});
