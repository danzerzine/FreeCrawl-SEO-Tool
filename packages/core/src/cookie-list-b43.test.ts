import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  COOKIE_JSON_MAX_CHARS,
  COOKIE_LIST_MAX,
  COOKIE_RECORDER_SCRIPT,
  buildCookieList,
  defaultCookiePath,
  mapScriptWrite,
  parseSetCookie,
  type CookieRecord,
} from './cookie-list.js';

const NOW = 1_800_000_000;
const URL1 = 'https://shop.example.com/a/b/page.html';

describe('B43 defaultCookiePath (RFC 6265 5.1.4)', () => {
  it.each([
    ['/', '/'],
    ['', '/'],
    ['/a', '/'],
    ['/a/b', '/a'],
    ['/a/b/', '/a/b'],
    ['/a/b/page.html', '/a/b'],
  ])('%s -> %s', (p, want) => expect(defaultCookiePath(p)).toBe(want));
});

describe('B43 parseSetCookie', () => {
  it('a bare cookie: host-only domain, default path, session, no flags', () => {
    expect(parseSetCookie('sid=abc', URL1, NOW)).toEqual({
      n: 'sid', d: 'shop.example.com', p: '/a/b', s: 0, h: 0, ss: '', e: -1, by: 'header',
    });
  });

  it('reads Domain (leading dot dropped, lower-cased), Path, Secure, HttpOnly and SameSite names', () => {
    expect(parseSetCookie('a=1; Domain=.Example.COM; Path=/x; Secure; HttpOnly; SameSite=Lax', URL1, NOW)).toEqual({
      n: 'a', d: 'example.com', p: '/x', s: 1, h: 1, ss: 'Lax', e: -1, by: 'header',
    });
    expect(parseSetCookie('a=1; samesite=strict', URL1, NOW)!.ss).toBe('Strict');
    expect(parseSetCookie('a=1; SameSite=None; Secure', URL1, NOW)!.ss).toBe('None');
    expect(parseSetCookie('a=1; SameSite=bogus', URL1, NOW)!.ss).toBe('');
  });

  it('Max-Age becomes unix seconds from now and wins over Expires', () => {
    expect(parseSetCookie('a=1; Max-Age=3600', URL1, NOW)!.e).toBe(NOW + 3600);
    const exp = new Date((NOW + 10) * 1000).toUTCString();
    expect(parseSetCookie(`a=1; Expires=${exp}`, URL1, NOW)!.e).toBe(NOW + 10);
    expect(parseSetCookie(`a=1; Expires=${exp}; Max-Age=60`, URL1, NOW)!.e).toBe(NOW + 60);
  });

  it('a deletion (expiry in the past, Max-Age <= 0) is skipped', () => {
    expect(parseSetCookie('a=; Max-Age=0', URL1, NOW)).toBeNull();
    expect(parseSetCookie('a=1; Max-Age=-5', URL1, NOW)).toBeNull();
    expect(parseSetCookie('a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT', URL1, NOW)).toBeNull();
  });

  it('a line without a name is skipped; an invalid Path falls back to the default path', () => {
    expect(parseSetCookie('=1', URL1, NOW)).toBeNull();
    expect(parseSetCookie('garbage', URL1, NOW)).toBeNull();
    expect(parseSetCookie('a=1; Path=relative', URL1, NOW)!.p).toBe('/a/b');
  });

  it('never carries the value: the record has no value key and the sentinel appears nowhere', () => {
    const rec = parseSetCookie('tok=SENTINEL_VALUE_12345; Path=/; Secure', URL1, NOW)!;
    expect(Object.keys(rec).sort()).toEqual(['by', 'd', 'e', 'h', 'n', 'p', 's', 'ss']);
    expect(JSON.stringify(rec)).not.toContain('SENTINEL_VALUE_12345');
  });
});

describe('B43 mapScriptWrite (domain and path come from the writing frame)', () => {
  it('fills a missing domain and path from the frame location, never from the top page', () => {
    expect(mapScriptWrite({ n: 'fra', fh: 'localhost', fp: '/frame/x.html' })).toEqual({
      n: 'fra', d: 'localhost', p: '/frame', s: null, h: 0, ss: null, e: null, by: 'script',
    });
  });

  it('keeps what the write named, with h = 0 and by = script', () => {
    expect(mapScriptWrite({ n: 'ga', d: '.Example.com', p: '/', s: 1, ss: 'Lax', e: NOW + 5, fh: 'www.example.com', fp: '/' })).toEqual({
      n: 'ga', d: 'example.com', p: '/', s: 1, h: 0, ss: 'Lax', e: NOW + 5, by: 'script',
    });
  });

  it('a malformed write is skipped', () => {
    expect(mapScriptWrite({ n: '', fh: 'a', fp: '/' })).toBeNull();
    expect(mapScriptWrite(null as never)).toBeNull();
  });
});

const rec = (n: string, over: Partial<CookieRecord> = {}): CookieRecord => ({
  n, d: 'a.com', p: '/', s: 0, h: 0, ss: '', e: -1, by: 'header', ...over,
});

describe('B43 buildCookieList (merge and caps)', () => {
  it('merges on name|domain|path, the header record wins, order is first seen (header first)', () => {
    const out = buildCookieList(
      [rec('x', { h: 1 }), rec('y')],
      [rec('x', { by: 'script', h: 0 }), rec('z', { by: 'script' }), rec('x', { d: 'b.com', by: 'script' })],
    );
    expect(out.list.map((c) => `${c.n}@${c.d}:${c.by}:${c.h}`)).toEqual([
      'x@a.com:header:1', 'y@a.com:header:0', 'z@a.com:script:0', 'x@b.com:script:0',
    ]);
    expect(out).toMatchObject({ total: 4, truncated: false });
  });

  it('a later header line for the same cookie replaces the earlier one in place', () => {
    const out = buildCookieList([rec('x', { e: 1 }), rec('y'), rec('x', { e: 2 })], []);
    expect(out.list.map((c) => [c.n, c.e])).toEqual([['x', 2], ['y', -1]]);
  });

  it('143 distinct cookies: 100 kept, total 143, truncated', () => {
    const many = Array.from({ length: 143 }, (_, i) => rec(`c${i}`));
    const out = buildCookieList(many, []);
    expect(COOKIE_LIST_MAX).toBe(100);
    expect(out.list).toHaveLength(100);
    expect(out.list[0]!.n).toBe('c0');
    expect(out.list[99]!.n).toBe('c99');
    expect(out.total).toBe(143);
    expect(out.truncated).toBe(true);
  });

  it('exactly 100 cookies: not truncated', () => {
    const out = buildCookieList(Array.from({ length: 100 }, (_, i) => rec(`c${i}`)), []);
    expect(out).toMatchObject({ total: 100, truncated: false });
    expect(out.list).toHaveLength(100);
  });

  it('the 32 KB cap: long names cut the list before 100 and set truncated', () => {
    const long = 'n'.repeat(1000);
    const out = buildCookieList(Array.from({ length: 60 }, (_, i) => rec(`${long}${i}`)), []);
    expect(out.total).toBe(60);
    expect(out.truncated).toBe(true);
    expect(out.list.length).toBeLessThan(60);
    expect(JSON.stringify(out.list).length).toBeLessThanOrEqual(COOKIE_JSON_MAX_CHARS);
    expect(COOKIE_JSON_MAX_CHARS).toBe(32 * 1024);
  });

  it('no cookies: total 0, empty list, not truncated', () => {
    expect(buildCookieList([], [])).toEqual({ total: 0, truncated: false, list: [] });
  });
});

// The recorder runs inside the page: here in a vm with a fake document, location and cookieStore.
interface Sandbox {
  window: Record<string, unknown>;
  document: { cookie: string };
  setterCalls: string[];
  storeCalls: unknown[][];
  storePromise: Promise<string>;
  getWrites(): Array<Record<string, unknown>>;
  setCookie(v: string): void;
  run(): void;
}
function sandbox(opts: { hostname?: string; pathname?: string; withStore?: boolean; failSetter?: boolean; now?: number } = {}): Sandbox {
  const setterCalls: string[] = [];
  const storeCalls: unknown[][] = [];
  const storePromise = Promise.resolve('ok');
  const g: Record<string, unknown> = {};
  function Document(): void {}
  Object.defineProperty(Document.prototype, 'cookie', {
    configurable: true,
    enumerable: true,
    get() { return ''; },
    set(v: string) {
      setterCalls.push(v);
    },
  });
  g.Document = Document;
  g.document = Object.create(Document.prototype);
  g.location = { hostname: opts.hostname ?? 'www.example.com', pathname: opts.pathname ?? '/dir/page', protocol: 'https:' };
  g.window = g;
  g.Date = Date;
  g.Object = Object;
  g.Math = Math;
  g.Number = Number;
  g.parseInt = parseInt;
  g.isNaN = isNaN;
  g.String = String;
  g.Array = Array;
  g.Promise = Promise;
  if (opts.withStore) {
    function CookieStore(): void {}
    CookieStore.prototype.set = function (...args: unknown[]) {
      storeCalls.push(args);
      return storePromise;
    };
    g.CookieStore = CookieStore;
    g.cookieStore = Object.create(CookieStore.prototype);
  }
  const ctx = vm.createContext(g);
  return {
    window: g,
    document: g.document as { cookie: string },
    setterCalls,
    storeCalls,
    storePromise,
    getWrites: () => ((g.__fcCookieWrites as Array<Record<string, unknown>>) ?? []),
    setCookie: (v) => { (g.document as { cookie: string }).cookie = v; },
    run: () => void vm.runInContext(COOKIE_RECORDER_SCRIPT, ctx),
  };
}

describe('B43 cookie recorder script (vm, fake document)', () => {
  it('records a write without its value and still calls the original setter once', () => {
    const s = sandbox({ hostname: 'frame.test', pathname: '/f/x.html' });
    s.run();
    s.setCookie('a=SENTINEL_VALUE_9; Path=/; Secure');
    expect(s.setterCalls).toEqual(['a=SENTINEL_VALUE_9; Path=/; Secure']);
    const w = s.getWrites();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ n: 'a', p: '/', s: 1, fh: 'frame.test', fp: '/f/x.html' });
    expect(JSON.stringify(s.getWrites())).not.toContain('SENTINEL_VALUE_9');
  });

  it('reads Domain, SameSite and expiry from the written string', () => {
    const s = sandbox({ now: 0 });
    s.run();
    s.setCookie('b=1; Domain=.example.com; SameSite=Lax; Max-Age=60');
    const w = s.getWrites()[0]!;
    expect(w).toMatchObject({ n: 'b', d: 'example.com', ss: 'Lax', s: 0 });
    expect(Math.abs((w.e as number) - (Math.floor(Date.now() / 1000) + 60))).toBeLessThanOrEqual(2);
  });

  it('a deletion (Max-Age=0, or an expiry in the past) is not recorded but is still forwarded', () => {
    const s = sandbox();
    s.run();
    s.setCookie('a=; Max-Age=0');
    s.setCookie('a=; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(s.getWrites()).toEqual([]);
    expect(s.setterCalls).toHaveLength(2);
  });

  it('keeps at most 300 writes and still forwards every one', () => {
    const s = sandbox();
    s.run();
    for (let i = 0; i < 350; i++) s.setCookie(`c${i}=1`);
    expect(s.getWrites()).toHaveLength(300);
    expect(s.setterCalls).toHaveLength(350);
  });

  it('never throws and calls the original once even when recording itself breaks', () => {
    const s = sandbox();
    s.run();
    // Break the recorder's storage: a non-array __fcCookieWrites makes push fail.
    s.window.__fcCookieWrites = Object.freeze([]);
    expect(() => s.setCookie('a=1')).not.toThrow();
    expect(s.setterCalls).toEqual(['a=1']);
    // A non-string write is the page's own business; the recorder must not add a throw.
    expect(() => s.setCookie(undefined as never)).not.toThrow();
    expect(s.setterCalls).toHaveLength(2);
  });

  it('cookieStore.set returns the original promise unchanged and records name without value', async () => {
    const s = sandbox({ withStore: true, hostname: 'ad.test', pathname: '/t/p' });
    s.run();
    const store = s.window.cookieStore as { set(...a: unknown[]): Promise<string> };
    const p = store.set({ name: 'fr', value: 'SENTINEL_VALUE_7', path: '/', sameSite: 'lax' });
    expect(p).toBe(s.storePromise);
    expect(s.storeCalls).toHaveLength(1);
    const w = s.getWrites();
    expect(w[0]).toMatchObject({ n: 'fr', p: '/', ss: 'Lax', fh: 'ad.test', fp: '/t/p' });
    expect(JSON.stringify(w)).not.toContain('SENTINEL_VALUE_7');
    expect(store.set('plain', 'SENTINEL_VALUE_8')).toBe(s.storePromise);
    expect(s.getWrites()[1]).toMatchObject({ n: 'plain' });
    expect(JSON.stringify(s.getWrites())).not.toContain('SENTINEL_VALUE_8');
    expect(s.storeCalls).toHaveLength(2);
  });

  it('is harmless without cookieStore and installs only once per window', () => {
    const s = sandbox();
    s.run();
    s.run();
    s.setCookie('a=1');
    expect(s.setterCalls).toEqual(['a=1']);
    expect(s.getWrites()).toHaveLength(1);
  });
});
