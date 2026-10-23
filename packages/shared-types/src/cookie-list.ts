/** The cookie list of a rendered page (B43): the shapes core writes, the database stores and the UI reads. */

export type CookieSameSite = 'Lax' | 'Strict' | 'None' | '';

/** One cookie of the stored list (`urls.cookies_json`); short keys keep the JSON small. No value, ever. */
export interface CookieRecord {
  /** name */
  n: string;
  /** domain, lower case, no leading dot; the host when the cookie is host-only */
  d: string;
  /** path */
  p: string;
  /** Secure: 1 / 0, null unknown */
  s: 0 | 1 | null;
  /** HttpOnly: 1 / 0 (a script cannot set it, so script cookies are always 0) */
  h: 0 | 1;
  /** SameSite: '' = not given, null unknown */
  ss: CookieSameSite | null;
  /** expiry in unix seconds, -1 = session cookie, null unknown */
  e: number | null;
  /** where the cookie came from */
  by: 'header' | 'script';
}

/** One row of the `cookies` dataset: one cookie of one page. */
export interface CookieExportRow {
  urlId: number;
  url: string;
  name: string;
  domain: string;
  path: string;
  secure: boolean | null;
  httpOnly: boolean;
  sameSite: string | null;
  /** unix seconds, -1 = session, null unknown */
  expires: number | null;
  setBy: 'header' | 'script';
  /** The page's true cookie count (also the ones dropped from the list). */
  pageCookiesTotal: number;
  /** The page's list is cut at 100 cookies / 32 KB. */
  pageCookiesTruncated: boolean;
}

/** The stored list of a row, [] when it is absent or unreadable. */
export function parseCookiesJson(json: string | null | undefined): CookieRecord[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v)
      ? v.filter((c): c is CookieRecord => typeof c === 'object' && c !== null && typeof (c as CookieRecord).n === 'string')
      : [];
  } catch {
    return [];
  }
}
