/**
 * The cookie list of a rendered page (B43): what the page set or tried to set while it loaded, from
 * `Set-Cookie` header lines and from script writes. Values are never kept (see cookies.ts): a record
 * has no value field and the parsers drop the value at once.
 *
 * Two sources, neither of them the browser's cookie jar. The pool has one BrowserContext shared by
 * several pages and every render wipes the jar in its `finally`, so a jar read is not per page.
 * Header lines come from this render's own responses; script writes come from a recorder that wraps
 * the cookie setters inside the page's own frames.
 */

import type { CookieRecord } from '@freecrawl/shared-types';

export type { CookieRecord, CookieSameSite } from '@freecrawl/shared-types';

/** At most this many cookies are kept per page; `total` stays true. */
export const COOKIE_LIST_MAX = 100;
/** The stored JSON array is at most this many characters. */
export const COOKIE_JSON_MAX_CHARS = 32 * 1024;
/** The recorder keeps at most this many writes per frame. */
export const COOKIE_RECORDER_MAX_WRITES = 300;

export interface CookieListResult {
  /** True count of distinct cookies seen, including dropped ones. */
  total: number;
  /** The list was cut by the count or size cap. */
  truncated: boolean;
  list: CookieRecord[];
}

/** One write seen by the recorder in a frame; no value. `fh` / `fp` are the writing frame's host and path. */
export interface ScriptCookieWrite {
  n: string;
  d?: string;
  p?: string;
  s?: number;
  ss?: string;
  e?: number;
  fh: string;
  fp: string;
}

/** RFC 6265 5.1.4 default-path of a URL path. */
export function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const last = pathname.lastIndexOf('/');
  return last <= 0 ? '/' : pathname.slice(0, last);
}

type CookieSameSite = NonNullable<CookieRecord['ss']>;

const normDomain = (d: string): string => d.trim().replace(/^\./, '').toLowerCase();

function normSameSite(v: string | undefined): CookieSameSite {
  const l = (v ?? '').trim().toLowerCase();
  if (l === 'lax') return 'Lax';
  if (l === 'strict') return 'Strict';
  if (l === 'none') return 'None';
  return '';
}

/**
 * One `Set-Cookie` line of a response from `responseUrl`. The value is dropped; a line that deletes the
 * cookie (Max-Age <= 0 or an expiry in the past) or has no name gives null.
 */
export function parseSetCookie(
  line: string,
  responseUrl: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): CookieRecord | null {
  const parts = line.split(';');
  const first = parts[0] ?? '';
  const eq = first.indexOf('=');
  if (eq < 0) return null;
  const name = first.slice(0, eq).trim();
  if (name === '') return null;
  let url: URL;
  try {
    url = new URL(responseUrl);
  } catch {
    return null;
  }
  let domain = '';
  let path = '';
  let secure = false;
  let httpOnly = false;
  let sameSite: CookieSameSite = '';
  let maxAge: number | null = null;
  let expires: number | null = null;
  for (const raw of parts.slice(1)) {
    const at = raw.indexOf('=');
    const key = (at < 0 ? raw : raw.slice(0, at)).trim().toLowerCase();
    const val = at < 0 ? '' : raw.slice(at + 1).trim();
    if (key === 'domain') domain = normDomain(val);
    else if (key === 'path') path = val;
    else if (key === 'secure') secure = true;
    else if (key === 'httponly') httpOnly = true;
    else if (key === 'samesite') sameSite = normSameSite(val);
    else if (key === 'max-age' && /^-?\d+$/.test(val)) maxAge = parseInt(val, 10);
    else if (key === 'expires') {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expires = Math.floor(t / 1000);
    }
  }
  let e = -1;
  if (maxAge !== null) {
    if (maxAge <= 0) return null;
    e = nowSec + maxAge;
  } else if (expires !== null) {
    if (expires <= nowSec) return null;
    e = expires;
  }
  return {
    n: name,
    d: domain !== '' ? domain : url.hostname.toLowerCase(),
    p: path.startsWith('/') ? path : defaultCookiePath(url.pathname),
    s: secure ? 1 : 0,
    h: httpOnly ? 1 : 0,
    ss: sameSite,
    e,
    by: 'header',
  };
}

/**
 * A write the recorder saw. A missing domain or path comes from the WRITING frame (`fh`, `fp`), not the
 * top page, so a cookie written by a cross-site iframe keeps the iframe's host.
 */
export function mapScriptWrite(w: ScriptCookieWrite): CookieRecord | null {
  if (!w || typeof w.n !== 'string' || w.n === '') return null;
  const fh = typeof w.fh === 'string' ? w.fh.toLowerCase() : '';
  const domain = typeof w.d === 'string' && w.d.trim() !== '' ? normDomain(w.d) : fh;
  if (domain === '') return null;
  const path = typeof w.p === 'string' && w.p.startsWith('/') ? w.p : defaultCookiePath(typeof w.fp === 'string' ? w.fp : '/');
  return {
    n: w.n,
    d: domain,
    p: path,
    s: w.s === 1 ? 1 : w.s === 0 ? 0 : null,
    h: 0,
    ss: w.ss === undefined ? null : normSameSite(w.ss),
    e: typeof w.e === 'number' && Number.isFinite(w.e) ? w.e : null,
    by: 'script',
  };
}

const keyOf = (c: CookieRecord): string => `${c.n}|${c.d}|${c.p}`;

/**
 * Merges both sources on name|domain|path (a header record wins over a script record), counts the
 * distinct cookies and cuts the list at 100 cookies / 32 KB of JSON. Order: header cookies in the order
 * seen, then script cookies in the order written.
 */
export function buildCookieList(header: readonly CookieRecord[], script: readonly CookieRecord[]): CookieListResult {
  const map = new Map<string, CookieRecord>();
  for (const c of header) map.set(keyOf(c), c);
  for (const c of script) {
    const k = keyOf(c);
    const have = map.get(k);
    if (have === undefined || have.by === 'script') map.set(k, c);
  }
  const all = [...map.values()];
  const list: CookieRecord[] = [];
  let size = 2;
  for (const c of all) {
    if (list.length >= COOKIE_LIST_MAX) break;
    const add = JSON.stringify(c).length + (list.length > 0 ? 1 : 0);
    if (size + add > COOKIE_JSON_MAX_CHARS) break;
    size += add;
    list.push(c);
  }
  return { total: all.length, truncated: list.length < all.length, list };
}

/**
 * Context-level init script (runs in every frame of every page of the pool). It wraps the
 * `document.cookie` setter and `CookieStore.prototype.set` and appends one record per write, without the
 * value, to `window.__fcCookieWrites` of that frame, with the frame's own `location.hostname` / `pathname`
 * (`fh`, `fp`). Contract: recording never throws; the original setter / `set` is called exactly once per
 * write; `cookieStore.set` returns the original promise. Deletions are not recorded. At most 300 writes.
 */
export const COOKIE_RECORDER_SCRIPT = `(function () {
  try {
    if (window.__fcCookieInstalled) return;
    window.__fcCookieInstalled = true;
    window.__fcCookieWrites = [];
    var MAX = ${COOKIE_RECORDER_MAX_WRITES};
    function push(rec) {
      try {
        var w = window.__fcCookieWrites;
        if (w.length >= MAX) return;
        rec.fh = String(location.hostname);
        rec.fp = String(location.pathname);
        w.push(rec);
      } catch (e) { /* recording must never break the page */ }
    }
    function fromString(v) {
      var parts = String(v).split(';');
      var first = parts[0];
      var eq = first.indexOf('=');
      if (eq < 0) return;
      var name = first.slice(0, eq).replace(/^\\s+|\\s+$/g, '');
      if (!name) return;
      var rec = { n: name, s: 0, ss: '', e: -1 };
      var maxAge = null, expires = null;
      for (var i = 1; i < parts.length; i++) {
        var raw = parts[i];
        var at = raw.indexOf('=');
        var key = (at < 0 ? raw : raw.slice(0, at)).replace(/^\\s+|\\s+$/g, '').toLowerCase();
        var val = at < 0 ? '' : raw.slice(at + 1).replace(/^\\s+|\\s+$/g, '');
        if (key === 'domain') rec.d = val.replace(/^\\./, '').toLowerCase();
        else if (key === 'path') { if (val.charAt(0) === '/') rec.p = val; }
        else if (key === 'secure') rec.s = 1;
        else if (key === 'samesite') {
          var l = val.toLowerCase();
          rec.ss = l === 'lax' ? 'Lax' : l === 'strict' ? 'Strict' : l === 'none' ? 'None' : '';
        }
        else if (key === 'max-age') { var m = parseInt(val, 10); if (!isNaN(m)) maxAge = m; }
        else if (key === 'expires') { var t = Date.parse(val); if (!isNaN(t)) expires = Math.floor(t / 1000); }
      }
      var now = Math.floor(Date.now() / 1000);
      if (maxAge !== null) { if (maxAge <= 0) return; rec.e = now + maxAge; }
      else if (expires !== null) { if (expires <= now) return; rec.e = expires; }
      push(rec);
    }
    function fromStore(a, b) {
      var rec = { s: 1, ss: 'Strict', e: -1 };
      if (a !== null && typeof a === 'object') {
        rec.n = String(a.name);
        if (a.domain) rec.d = String(a.domain).replace(/^\\./, '').toLowerCase();
        if (a.path && String(a.path).charAt(0) === '/') rec.p = String(a.path);
        if (a.sameSite) {
          var l = String(a.sameSite).toLowerCase();
          rec.ss = l === 'lax' ? 'Lax' : l === 'none' ? 'None' : 'Strict';
        }
        if (a.expires !== undefined && a.expires !== null) {
          var ex = Math.floor(Number(a.expires) / 1000);
          if (!isNaN(ex)) { if (ex <= Math.floor(Date.now() / 1000)) return; rec.e = ex; }
        }
      } else {
        rec.n = String(a);
      }
      if (!rec.n || rec.n === 'undefined') return;
      push(rec);
    }
    var desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (desc && desc.set && desc.configurable) {
      var origSet = desc.set;
      Object.defineProperty(Document.prototype, 'cookie', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (v) {
          try { fromString(v); } catch (e) { /* never throws */ }
          return origSet.call(this, v);
        }
      });
    }
    if (typeof CookieStore !== 'undefined' && CookieStore.prototype && typeof CookieStore.prototype.set === 'function') {
      var origStoreSet = CookieStore.prototype.set;
      CookieStore.prototype.set = function () {
        try { fromStore(arguments[0], arguments[1]); } catch (e) { /* never throws */ }
        return origStoreSet.apply(this, arguments);
      };
    }
  } catch (e) { /* the page must load whatever happens here */ }
})();`;
