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
 * The code tables are generated from Node's full ICU
 * (`scripts/generate-hreflang-codes.mjs`) rather than read from `Intl` at
 * run time: the desktop app runs this inside Electron, whose trimmed ICU
 * has no name for dozens of valid codes (`ff`, `kl`, `419` in `es-419`) —
 * asking it there called real codes invalid. ICU's alias data, which is
 * the same in both runtimes, still decides `UK` → `GB` and `eng` → `en`: a
 * subtag that only exists as an alias is reported as invalid, because
 * search engines match hreflang against the canonical codes.
 */
import { LANGUAGES_2, REGIONS_2, REGIONS_NUMERIC, SCRIPTS } from './hreflang-codes.js';

/** Region subtags that are reserved or private-use, never a real country. */
const RESERVED_REGIONS = new Set(['EU', 'EZ', 'UN', 'ZZ', 'QO', 'AA']);

const SHAPE = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?$/i;

let tables: { languages: Set<string>; scripts: Set<string>; regions: Set<string>; numeric: Set<string> } | null =
  null;

function codeTables(): NonNullable<typeof tables> {
  tables ??= {
    languages: new Set(LANGUAGES_2.split(' ')),
    scripts: new Set(SCRIPTS.split(' ')),
    regions: new Set(REGIONS_2.split(' ')),
    numeric: new Set(REGIONS_NUMERIC.split(' ')),
  };
  return tables;
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
  const t = codeTables();

  if (lang.length === 2) {
    if (!t.languages.has(lang)) return false;
  } else {
    // A three-letter code for a language that has a two-letter one (`eng`,
    // `jpn`) isn't ISO 639-1. Three-letter-only languages (`fil`, `dsb`,
    // `skr`) are left alone — ISO 639-3 has thousands no table here lists,
    // and an unknown one is not evidence of a mistake.
    if ((canonical(lang)?.length ?? 0) === 2) return false;
  }

  if (script) {
    const s = script.charAt(0).toUpperCase() + script.slice(1).toLowerCase();
    if (!t.scripts.has(s)) return false;
  }

  if (region) {
    if (/^\d{3}$/.test(region)) return t.numeric.has(region);
    if (RESERVED_REGIONS.has(region)) return false;
    if (/^(Q[M-Z]|X[A-Z])$/.test(region) && region !== 'XK') return false;
    if (!t.regions.has(region)) return false;
    // `UK` is in the table only as an alias of `GB`.
    if (canonical(`${lang}-${region}`)?.split('-').pop()?.toUpperCase() !== region) return false;
  }
  return true;
}
