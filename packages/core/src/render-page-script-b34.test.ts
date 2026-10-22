import { describe, expect, it } from 'vitest';
import type { BrowserPool } from './browser-pool.js';
import { PAGE_SCRIPT_MARK, runPageScript } from './page-script.js';
import { renderLimitMs, renderUrl, type RenderOptions } from './render-fetcher.js';

// M11 B34: the page script, with a fake page (no Chromium).

type Env = { v?: string; e?: string };

interface FakeOpts {
  status?: number;
  /** What the script's evaluate does; gets the call count. */
  script?: () => Promise<Env | undefined>;
  /** The trivial watchdog evaluate. */
  probe?: () => Promise<unknown>;
  contents?: string[];
  waitMs?: number;
}

function fakePage(o: FakeOpts = {}) {
  const log: string[] = [];
  const closers: Array<() => void> = [];
  let contentCalls = 0;
  const response = {
    status: () => o.status ?? 200,
    statusText: () => 'OK',
    allHeaders: async () => ({}),
    url: () => 'http://x.test/',
    text: async () => '<html>served</html>',
  };
  const page = {
    closed: false,
    goto: async () => {
      log.push('goto');
      return response;
    },
    content: async () => {
      log.push('content');
      const c = o.contents ?? ['<html>pre</html>', '<html>post</html>'];
      return c[Math.min(contentCalls++, c.length - 1)] as string;
    },
    evaluate: async (expr: string) => {
      if (expr.includes(PAGE_SCRIPT_MARK)) {
        log.push('script');
        return o.script ? o.script() : { v: 'null' };
      }
      if (expr === '1') {
        log.push('probe');
        return o.probe ? o.probe() : 1;
      }
      return 'http://x.test/';
    },
    url: () => 'http://x.test/',
    waitForTimeout: async () => {
      log.push('wait');
      // Like a real page: closing it rejects what is pending.
      if (o.waitMs) {
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, o.waitMs);
          closers.push(() => {
            clearTimeout(t);
            rej(new Error('Target closed'));
          });
        });
      }
    },
    waitForSelector: async () => {},
    viewportSize: () => null,
    close: async () => {
      page.closed = true;
      log.push('close');
      closers.splice(0).forEach((c) => c());
    },
    context: () => ({ clearCookies: async () => {} }),
  };
  return { page, log };
}

function poolOf(page: unknown, released: boolean[] = []): BrowserPool {
  return {
    acquire: async () => ({ page, release: (r?: boolean) => released.push(r === true) }),
  } as unknown as BrowserPool;
}

const base: RenderOptions = {
  timeoutMs: 1000,
  ajaxTimeoutMs: 10,
  waitUntil: 'load',
  pageScript: 'return 1',
  pageScriptTimeoutMs: 100,
};

describe('runPageScript (unit, fake page)', () => {
  it('returns the value as JSON', async () => {
    const { page } = fakePage({ script: async () => ({ v: '{"a":1}' }) });
    const r = await runPageScript(page as never, 'return {a:1}', 100);
    expect(r).toEqual({ json: '{"a":1}', timedOut: false });
  });

  it('stores nothing when the script returns nothing', async () => {
    const { page } = fakePage({ script: async () => ({}) });
    const r = await runPageScript(page as never, 'x()', 100);
    expect(r).toEqual({ json: undefined, timedOut: false });
  });

  it('records a thrown error as {error}', async () => {
    const { page } = fakePage({ script: async () => ({ e: 'boom' }) });
    const r = await runPageScript(page as never, 'throw new Error("boom")', 100);
    expect(JSON.parse(r.json as string)).toEqual({ error: 'boom' });
    expect(r.timedOut).toBe(false);
  });

  it('records a rejecting evaluate (syntax error, closed page) as {error}', async () => {
    const { page } = fakePage({
      script: async () => {
        throw new Error('SyntaxError: bad');
      },
    });
    const r = await runPageScript(page as never, 'let let', 100);
    expect(JSON.parse(r.json as string).error).toContain('SyntaxError');
  });

  it('records a timeout as {error:"timeout"} and survives the losing evaluate rejecting later', async () => {
    const unhandled: unknown[] = [];
    const h = (e: unknown): void => void unhandled.push(e);
    process.on('unhandledRejection', h);
    try {
      const { page } = fakePage({
        script: () => new Promise((_, rej) => setTimeout(() => rej(new Error('Target closed')), 150)),
      });
      const r = await runPageScript(page as never, 'await never', 50);
      expect(JSON.parse(r.json as string)).toEqual({ error: 'timeout' });
      expect(r.timedOut).toBe(true);
      await new Promise((res) => setTimeout(res, 250));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', h);
    }
  });

  it('replaces a result over 16 KB with {error:"result too large"}, never truncated', async () => {
    const big = JSON.stringify('x'.repeat(16 * 1024 + 1));
    const { page } = fakePage({ script: async () => ({ v: big }) });
    const r = await runPageScript(page as never, 'return big', 100);
    expect(JSON.parse(r.json as string)).toEqual({ error: 'result too large' });
    const ok = JSON.stringify('y'.repeat(16 * 1024 - 2));
    const p2 = fakePage({ script: async () => ({ v: ok }) });
    expect((await runPageScript(p2.page as never, 'return ok', 100)).json).toBe(ok);
  });
});

describe('renderUrl with a page script (unit, fake page)', () => {
  it('runs after the wait and before the final page.content(), and keeps the pre-script DOM', async () => {
    const { page, log } = fakePage({ script: async () => ({ v: '"Title"' }) });
    const r = await renderUrl('http://x.test/', poolOf(page), base);
    expect(r.ok).toBe(true);
    expect(r.scriptRan).toBe(true);
    expect(r.scriptResult).toBe('"Title"');
    expect(r.renderedHtmlPreScript).toBe('<html>pre</html>');
    expect(r.html).toBe('<html>post</html>');
    const order = log.filter((l) => l !== 'probe');
    expect(order.slice(0, 5)).toEqual(['goto', 'wait', 'content', 'script', 'content']);
  });

  it('does nothing without a script: one content(), no scriptRan', async () => {
    const { page, log } = fakePage();
    const r = await renderUrl('http://x.test/', poolOf(page), { ...base, pageScript: '' });
    expect(r.scriptRan).toBeUndefined();
    expect(r.renderedHtmlPreScript).toBeUndefined();
    expect(log.filter((l) => l === 'content')).toHaveLength(1);
    expect(log).not.toContain('script');
  });

  it('a whitespace-only script is no script: one content(), no limit timer', async () => {
    const { page, log } = fakePage();
    const r = await renderUrl('http://x.test/', poolOf(page), { ...base, pageScript: '  \n\t ' });
    expect(r.scriptRan).toBeUndefined();
    expect(log.filter((l) => l === 'content')).toHaveLength(1);
    expect(log).not.toContain('script');
  });

  it('does not run the script on a page the browser got a non-2xx for', async () => {
    const { page, log } = fakePage({ status: 404 });
    const r = await renderUrl('http://x.test/', poolOf(page), base);
    expect(r.scriptRan).toBeUndefined();
    expect(log).not.toContain('script');
  });

  it('a throwing script never fails the render', async () => {
    const { page } = fakePage({ script: async () => ({ e: 'boom' }) });
    const r = await renderUrl('http://x.test/', poolOf(page), base);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.scriptResult as string)).toEqual({ error: 'boom' });
    expect(r.html).toBe('<html>post</html>');
  });

  it('a script that never ends: the render ends near the script timeout, page kept', async () => {
    const released: boolean[] = [];
    const { page } = fakePage({ script: () => new Promise(() => {}) });
    const t0 = Date.now();
    const r = await renderUrl('http://x.test/', poolOf(page, released), base);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.scriptResult as string)).toEqual({ error: 'timeout' });
    expect(released).toEqual([false]);
  });

  it('watchdog: a script that blocks the page is closed and discarded; render fails as "script blocked the page"', async () => {
    const released: boolean[] = [];
    const { page } = fakePage({
      script: () => new Promise(() => {}),
      probe: () => new Promise(() => {}),
    });
    const r = await renderUrl('http://x.test/', poolOf(page, released), {
      ...base,
      pageScriptProbeMs: 40,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('script blocked the page');
    expect(page.closed).toBe(true);
    expect(released).toEqual([true]);
  });
});

describe('render time limit starts after acquire (R2-1)', () => {
  // Limit = goto 20 + ajax 100 + script 500 (the clamp minimum) + margin 80 = 700 ms; each call takes ~560 ms (0.8 of it).
  const opts: RenderOptions = {
    timeoutMs: 20,
    ajaxTimeoutMs: 100,
    waitUntil: 'load',
    pageScript: 'return 1',
    pageScriptTimeoutMs: 500,
    renderMarginMs: 80,
  };

  function twoSlotPool(): BrowserPool {
    const slots = [0, 1].map((i) => ({ i, busy: false, page: fakePage({ waitMs: 560 }).page }));
    const waiting: Array<(s: (typeof slots)[number]) => void> = [];
    return {
      acquire: async () => {
        const free = slots.find((x) => !x.busy);
        const slot =
          free ?? (await new Promise<(typeof slots)[number]>((r) => waiting.push(r)));
        slot.busy = true;
        return {
          page: slot.page,
          release: () => {
            slot.busy = false;
            waiting.shift()?.(slot);
          },
        };
      },
    } as unknown as BrowserPool;
  }

  it('2 slots, 6 calls at once, each ~0.8 of the limit: all 6 render ok', async () => {
    expect(renderLimitMs(opts)).toBe(700);
    const pool = twoSlotPool();
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => renderUrl('http://x.test/', pool, opts)),
    );
    // Three rounds of ~560 ms: a limit that wrapped the call (700 ms) would fail the last four.
    expect(Date.now() - t0).toBeGreaterThan(1400);
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true, true]);
  });

  it('a render that outlives its limit is a failed render and its page is discarded', async () => {
    const released: boolean[] = [];
    const slow = fakePage({ waitMs: 2000 });
    const r = await renderUrl('http://x.test/', poolOf(slow.page, released), opts);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/render time limit/);
    expect(slow.page.closed).toBe(true);
    expect(released).toEqual([true]);
  });

  it('an aborted signal right after acquire: slot released, no navigation', async () => {
    const released: boolean[] = [];
    const { page, log } = fakePage();
    const ac = new AbortController();
    ac.abort();
    const r = await renderUrl('http://x.test/', poolOf(page, released), base, ac.signal);
    expect(r.ok).toBe(false);
    expect(log).not.toContain('goto');
    expect(released).toEqual([false]);
  });

  it('no limit runs without a page script', async () => {
    const { page } = fakePage({ waitMs: 120 });
    const r = await renderUrl('http://x.test/', poolOf(page), {
      timeoutMs: 20,
      ajaxTimeoutMs: 100,
      waitUntil: 'load',
      pageScript: '',
      renderMarginMs: 1,
    });
    expect(r.ok).toBe(true);
  });

  it('each renderUrl call gets its own limit (the mobile pass call too)', async () => {
    const o: RenderOptions = opts; // limit 700; two calls of ~560 ms back to back
    const a = fakePage({ waitMs: 560 });
    const b = fakePage({ waitMs: 560 });
    const r1 = await renderUrl('http://x.test/', poolOf(a.page), o);
    const r2 = await renderUrl('http://x.test/', poolOf(b.page), o);
    expect([r1.ok, r2.ok]).toEqual([true, true]);
  });
});
