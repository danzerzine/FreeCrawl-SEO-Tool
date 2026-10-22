import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { BrowserPool } from './browser-pool.js';
import { renderUrl } from './render-fetcher.js';

// renderUrl with a fake page that emits events during goto (M11 B35 step 1).
function fakePool(duringGoto: (page: EventEmitter) => void, failGoto = false) {
  const page = Object.assign(new EventEmitter(), {
    goto: async () => {
      duringGoto(page);
      if (failGoto) throw new Error('net::ERR_NAME_NOT_RESOLVED');
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
  const pool = { acquire: async () => ({ page, release: () => {} }) } as unknown as BrowserPool;
  return { pool, page };
}
const base = { timeoutMs: 1000, ajaxTimeoutMs: 0, waitUntil: 'load' as const };
const err = (p: EventEmitter) => p.emit('console', { type: () => 'error', text: () => 'x' });
const EVENTS = ['console', 'pageerror', 'request', 'requestfailed', 'response'];

describe('renderUrl console log (B35)', () => {
  it('returns consoleLog when collectConsole is on and detaches the listeners', async () => {
    const { pool, page } = fakePool(err);
    const r = await renderUrl('http://x.test/', pool, { ...base, collectConsole: true });
    expect(r.consoleLog?.errors).toBe(1);
    for (const ev of EVENTS) expect(page.listenerCount(ev)).toBe(0);
  });

  it('records nothing and listens to nothing when the option is off', async () => {
    const { pool, page } = fakePool((p) => {
      expect(p.listenerCount('console')).toBe(0);
      err(p);
    });
    const r = await renderUrl('http://x.test/', pool, base);
    expect(r.consoleLog).toBeUndefined();
    expect(page.listenerCount('console')).toBe(0);
  });

  it('a failed render has no consoleLog and still detaches', async () => {
    const { pool, page } = fakePool(err, true);
    const r = await renderUrl('http://x.test/', pool, { ...base, collectConsole: true });
    expect(r.ok).toBe(false);
    expect(r.consoleLog).toBeUndefined();
    for (const ev of EVENTS) expect(page.listenerCount(ev)).toBe(0);
  });

  it('skips requests of the blocked types', async () => {
    const { pool } = fakePool((p) => {
      const rq = {
        url: () => 'http://x.test/i.png',
        resourceType: () => 'image',
        failure: () => ({ errorText: 'net::ERR_FAILED' }),
        isNavigationRequest: () => false,
      };
      p.emit('request', rq);
      p.emit('requestfailed', rq);
    });
    const r = await renderUrl('http://x.test/', pool, {
      ...base,
      collectConsole: true,
      blockedTypes: ['image'],
    });
    expect(r.consoleLog).toEqual({ errors: 0, failed: 0, entries: [] });
  });
});
