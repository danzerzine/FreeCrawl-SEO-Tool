/**
 * hreflang value validation.
 *
 * Google accepts `x-default` or `language[-Script][-REGION]`: an ISO 639-1
 * language, an optional ISO 15924 script and an optional ISO 3166-1
 * alpha-2 (or UN M.49 numeric) region. A purely structural check let the
 * two most common real-world mistakes through — `en-UK` (the country code
 * is GB) and `jp` (the language code is ja) — while rejecting valid
 * script subtags such as `zh-Hant`.
 *
 * The code tables come from ICU via `Intl` (Node and Electron ship full
 * ICU), so there is no hand-maintained list to drift out of date. ICU also
 * knows the deprecated aliases (`UK` → `GB`, `eng` → `en`); a subtag that
 * only exists as an alias is reported as invalid, because search engines
 * match hreflang against the canonical codes.
 */

/** Region subtags that are reserved or private-use, never a real country. */
const RESERVED_REGIONS = new Set(['EU', 'EZ', 'UN', 'ZZ', 'QO', 'AA']);

const SHAPE = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?$/i;

type Names = { of(code: string): string | undefined };
let names: { language: Names; script: Names; region: Names } | null | undefined;

function displayNames(): typeof names {
  if (names !== undefined) return names;
  try {
    const make = (type: 'language' | 'script' | 'region'): Names =>
      new Intl.DisplayNames(['en'], { type, fallback: 'none' });
    names = { language: make('language'), script: make('script'), region: make('region') };
  } catch {
    // A runtime without ICU display names: fall back to the shape check.
    names = null;
  }
  return names;
}

function canonical(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

export function isValidHreflangCode(raw: string): boolean {
  const code = raw.trim();
  if (!code) return false;
  if (code.toLowerCase() === 'x-default') return true;
  const m = SHAPE.exec(code);
  if (!m) return false;
  const lang = (m[1] ?? '').toLowerCase();
  const script = m[2];
  const region = m[3]?.toUpperCase();

  const dn = displayNames();
  if (!dn) return true;

  if (!dn.language.of(lang)) return false;
  // A three-letter code for a language that has a two-letter one (`eng`,
  // `tur`) isn't ISO 639-1; three-letter-only languages (`fil`) are fine.
  if (lang.length === 3 && (canonical(lang)?.length ?? 0) === 2) return false;

  if (script) {
    const s = script.charAt(0).toUpperCase() + script.slice(1).toLowerCase();
    if (!dn.script.of(s)) return false;
  }

  if (region) {
    if (/^\d{3}$/.test(region)) return dn.region.of(region) !== undefined;
    if (RESERVED_REGIONS.has(region)) return false;
    if (/^(Q[M-Z]|X[A-Z])$/.test(region) && region !== 'XK') return false;
    if (!dn.region.of(region)) return false;
    // `UK` resolves to a name only as an alias of `GB`.
    if (canonical(`${lang}-${region}`)?.split('-').pop()?.toUpperCase() !== region) return false;
  }
  return true;
}
