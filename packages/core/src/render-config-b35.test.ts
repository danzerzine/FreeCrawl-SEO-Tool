import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CRAWL_CONFIG, type CrawlConfig } from '@freecrawl/shared-types';
import type { BrowserPool } from './browser-pool.js';
import { createRenderHook, renderOptionsFromConfig } from './render-config.js';

const config = (jsRender: Partial<CrawlConfig['jsRender']> = {}): CrawlConfig => ({
  ...DEFAULT_CRAWL_CONFIG,
  jsRender: { ...DEFAULT_CRAWL_CONFIG.jsRender, ...jsRender },
});

describe('jsRender.consoleErrors (B35 step 3)', () => {
  it('is off by default', () => {
    expect(DEFAULT_CRAWL_CONFIG.jsRender.consoleErrors).toBe(false);
    expect(renderOptionsFromConfig(config()).collectConsole).toBeFalsy();
  });

  it('turns collecting on and passes the blocked resource types', () => {
    const o = renderOptionsFromConfig(
      config({
        consoleErrors: true,
        blockResources: { image: true, font: false, media: false, stylesheet: false, script: false },
      }),
    );
    expect(o.collectConsole).toBe(true);
    expect(o.blockedTypes).toEqual(['image']);
  });
});

describe('createRenderHook console log (B35 step 2)', () => {
  it('passes consoleLog through to the hook result', async () => {
    const page = Object.assign(new EventEmitter(), {
      goto: async () => {
        page.emit('pageerror', new Error('boom'));
        return {
          status: () => 200,
          statusText: () => 'OK',
          allHeaders: async () => ({}),
          url: () => 'http://x.test/',
          text: async () => '<html></html>',
        };
      },
      content: async () => '<html></html>',
      evaluate: async () => 'http://x.test/',
      url: () => 'http://x.test/',
      waitForTimeout: async () => {},
      waitForSelector: async () => {},
      viewportSize: () => null,
      close: async () => {},
      context: () => ({ clearCookies: async () => {} }),
    });
    const pool = {
      isClosed: () => false,
      acquire: async () => ({ page, release: () => {} }),
    } as unknown as BrowserPool;
    const hook = createRenderHook(pool, config({ consoleErrors: true, ajaxTimeoutMs: 0 }));
    const r = await hook('http://x.test/', null, new AbortController().signal);
    expect(r.consoleLog).toEqual({ errors: 1, failed: 0, entries: [{ kind: 'pageerror', text: 'boom' }] });
    const off = createRenderHook(pool, config({ ajaxTimeoutMs: 0 }));
    expect((await off('http://x.test/', null, new AbortController().signal)).consoleLog).toBeUndefined();
  });
});
