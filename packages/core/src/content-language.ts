/**
 * Content-language detection for the "declared `lang` ≠ content language"
 * check and for choosing a readability formula.
 *
 * Deliberately not a general-purpose identifier. Its one job is to answer
 * "is this page obviously NOT written in the language it declares?" with
 * as close to zero false alarms as possible, so it only ever speaks up on
 * two kinds of evidence a reviewer would accept at a glance:
 *
 *  1. **Writing system.** `lang="en"` over Hangul, Cyrillic or Devanagari
 *     text is a mismatch no matter which language the text actually is.
 *  2. **Function words.** Every language leans on a small closed set of
 *     words (en *the / and / of*, tr *ve / için / ile*, es *el / los / y*).
 *     Only the words distinctive to one language in the table are scored,
 *     so the shared *de / la / a / o* of the Romance languages never vote.
 *     A page declaring language X whose prose contains almost none of X's
 *     function words while being dense with Y's is written in Y.
 *
 * Statistical identifiers (franc and friends) rank close languages within
 * a hair of each other — Turkish prose scores Turkmen at 0.99 of Turkish —
 * which is fine for picking a dictionary and wrong for raising an issue.
 * Anything this module can't call with confidence is reported as unknown,
 * never as a mismatch.
 */

/** Below this many word tokens function-word ratios are noise. */
const MIN_TOKENS = 40;
/** Below this many letters the script distribution is noise. */
const MIN_LETTERS = 120;
/** A declared language this rare in its own function words isn't the text's language. */
const DECLARED_ABSENT_RATIO = 0.015;
/** A language this dense in its distinctive function words is the text's language. */
const DETECTED_PRESENT_RATIO = 0.05;
/** Only this much of the text is scanned — plenty for a stable reading. */
const SAMPLE_CHARS = 6_000;

// Function words per language, lower-case. Words that occur in more than
// one list are dropped from all of them when scoring (see DISTINCTIVE).
// One-letter words that are also common elsewhere (pt *a* / *o*, it *i*
// — English "a" and "I") are left out so English prose can't vote for them.
const FUNCTION_WORDS: Readonly<Record<string, readonly string[]>> = {
  en: ['the', 'and', 'of', 'to', 'is', 'that', 'for', 'it', 'with', 'as', 'was', 'on', 'are', 'be', 'this', 'by', 'at', 'from', 'or', 'an', 'have', 'not', 'but', 'which', 'they', 'you', 'we', 'their', 'has', 'were', 'can', 'will', 'been', 'more', 'there', 'all', 'would', 'its', 'also', 'about', 'into', 'how', 'what', 'when', 'your', 'our', 'these', 'than', 'other', 'every', 'very', 'until', 'some'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'çok', 'gibi', 'olan', 'olarak', 'kadar', 'değil', 'ama', 'veya', 'şey', 'nasıl', 'neden', 'sonra', 'önce', 'her', 'hem', 'şu', 'bunu', 'buna', 'bunun', 'ise', 'yok', 'ancak', 'çünkü', 'göre', 'sadece', 'aynı', 'diğer', 'tüm', 'bütün', 'olduğu', 'olur', 'oldu', 'artık', 'yani', 'üzere', 'arasında', 'hakkında', 'ya', 'mı', 'mu', 'mü', 'en', 'daha', 'var'],
  az: ['və', 'üçün', 'ilə', 'çox', 'kimi', 'olaraq', 'qədər', 'deyil', 'amma', 'nə', 'necə', 'niyə', 'əvvəl', 'hər', 'həm', 'həmin', 'isə', 'yox', 'lakin', 'çünki', 'görə', 'yalnız', 'eyni', 'digər', 'olduğu', 'artıq', 'yəni', 'haqqında', 'ən', 'də', 'bu', 'bir', 'daha', 'var'],
  es: ['el', 'los', 'las', 'del', 'y', 'que', 'una', 'es', 'por', 'con', 'para', 'su', 'sus', 'al', 'como', 'más', 'pero', 'este', 'esta', 'son', 'entre', 'cuando', 'muy', 'sin', 'sobre', 'también', 'hasta', 'hay', 'donde', 'quien', 'desde', 'todo', 'nos', 'durante', 'porque', 'cada', 'otros', 'ese', 'eso', 'la', 'de', 'en', 'un', 'lo'],
  fr: ['le', 'les', 'des', 'du', 'et', 'une', 'est', 'qui', 'dans', 'pas', 'sur', 'au', 'aux', 'avec', 'ce', 'cette', 'il', 'elle', 'ils', 'sont', 'plus', 'mais', 'ou', 'ne', 'son', 'sa', 'ses', 'leur', 'nous', 'vous', 'être', 'été', 'comme', 'tout', 'aussi', 'très', 'sans', 'peut', 'même', 'la', 'de', 'en', 'un', 'que', 'par', 'pour'],
  pt: ['os', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'um', 'uma', 'é', 'com', 'não', 'mais', 'como', 'mas', 'ao', 'aos', 'ou', 'seu', 'sua', 'são', 'foi', 'pelo', 'pela', 'também', 'já', 'muito', 'quando', 'isso', 'este', 'esta', 'sem', 'até', 'ser', 'há', 'e', 'de', 'que', 'para', 'por'],
  it: ['il', 'gli', 'della', 'dei', 'delle', 'è', 'che', 'per', 'con', 'non', 'si', 'alla', 'sono', 'come', 'ma', 'più', 'anche', 'questo', 'questa', 'nel', 'nella', 'tra', 'fra', 'ha', 'essere', 'molto', 'cui', 'suo', 'sua', 'loro', 'quando', 'perché', 'di', 'del', 'un', 'una', 'la', 'le', 'lo', 'e', 'in', 'al', 'da'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'zu', 'den', 'dem', 'des', 'mit', 'sich', 'auf', 'für', 'von', 'im', 'auch', 'es', 'an', 'werden', 'wird', 'aus', 'er', 'sie', 'wir', 'ihr', 'sind', 'war', 'bei', 'oder', 'nach', 'wie', 'aber', 'noch', 'nur', 'über', 'so', 'kann', 'dass', 'durch', 'hat', 'einen', 'einer'],
  nl: ['het', 'een', 'van', 'dat', 'op', 'te', 'voor', 'niet', 'met', 'zijn', 'aan', 'er', 'ook', 'als', 'bij', 'maar', 'om', 'door', 'wordt', 'worden', 'nog', 'naar', 'kan', 'dan', 'dit', 'deze', 'wat', 'uit', 'hun', 'ze', 'we', 'je', 'wij', 'hebben', 'heeft', 'zo', 'meer', 'onze', 'de', 'en', 'is', 'in'],
  pl: ['w', 'na', 'z', 'nie', 'się', 'do', 'to', 'że', 'jest', 'jak', 'ale', 'po', 'co', 'tak', 'za', 'od', 'przez', 'dla', 'są', 'jego', 'jej', 'ich', 'oraz', 'czy', 'lub', 'być', 'może', 'już', 'tylko', 'przy', 'tym', 'ten', 'ta', 'które', 'który', 'która', 'także', 'bardzo'],
  sv: ['och', 'att', 'det', 'som', 'på', 'är', 'av', 'för', 'med', 'till', 'den', 'har', 'inte', 'om', 'ett', 'jag', 'men', 'så', 'från', 'kan', 'ska', 'vi', 'vid', 'eller', 'sig', 'när', 'hur', 'alla', 'man', 'efter', 'också', 'nu', 'där'],
  fi: ['ja', 'on', 'ei', 'se', 'että', 'oli', 'ovat', 'kuin', 'myös', 'tai', 'mutta', 'kun', 'jos', 'niin', 'sekä', 'joka', 'jotka', 'hän', 'tämä', 'nämä', 'ole', 'voi', 'vain', 'mukaan', 'sen', 'sitä', 'kaikki', 'olla', 'jo', 'nyt', 'vielä'],
  ro: ['și', 'în', 'cu', 'pe', 'care', 'este', 'nu', 'că', 'din', 'pentru', 'mai', 'sunt', 'sau', 'ale', 'au', 'fost', 'ca', 'dar', 'prin', 'lui', 'acest', 'această', 'foarte', 'fi', 'ce', 'cum'],
  hu: ['az', 'és', 'hogy', 'nem', 'egy', 'van', 'meg', 'ez', 'csak', 'mint', 'már', 'még', 'vagy', 'volt', 'ki', 'ha', 'kell', 'nagyon', 'mert', 'azt', 'ezt', 'minden', 'lesz', 'akkor', 'után', 'között', 'pedig'],
  id: ['yang', 'dan', 'di', 'ini', 'itu', 'dengan', 'untuk', 'dari', 'dalam', 'tidak', 'akan', 'pada', 'juga', 'ke', 'ada', 'atau', 'oleh', 'karena', 'sudah', 'bisa', 'saya', 'kami', 'kita', 'mereka', 'adalah', 'telah', 'lebih', 'seperti', 'hanya', 'harus', 'sangat', 'bahwa'],
  ru: ['и', 'в', 'не', 'на', 'что', 'с', 'по', 'это', 'как', 'к', 'из', 'о', 'для', 'за', 'от', 'он', 'она', 'но', 'так', 'же', 'бы', 'все', 'его', 'ее', 'её', 'был', 'были', 'только', 'или', 'при', 'мы', 'вы', 'они', 'уже', 'есть', 'если'],
  uk: ['і', 'й', 'що', 'це', 'як', 'до', 'із', 'від', 'він', 'вона', 'але', 'його', 'її', 'був', 'були', 'тільки', 'або', 'ми', 'ви', 'вони', 'вже', 'є', 'якщо', 'та', 'також', 'дуже'],
};

/** word → the single language it is distinctive for (shared words omitted). */
const DISTINCTIVE: ReadonlyMap<string, string> = (() => {
  const owners = new Map<string, Set<string>>();
  for (const [lang, words] of Object.entries(FUNCTION_WORDS)) {
    for (const w of words) {
      let set = owners.get(w);
      if (!set) owners.set(w, (set = new Set()));
      set.add(lang);
    }
  }
  const out = new Map<string, string>();
  for (const [w, langs] of owners) if (langs.size === 1) out.set(w, [...langs][0] as string);
  return out;
})();

type Script =
  | 'latin'
  | 'cyrillic'
  | 'greek'
  | 'arabic'
  | 'hebrew'
  | 'devanagari'
  | 'bengali'
  | 'gurmukhi'
  | 'gujarati'
  | 'tamil'
  | 'telugu'
  | 'kannada'
  | 'malayalam'
  | 'sinhala'
  | 'thai'
  | 'lao'
  | 'khmer'
  | 'myanmar'
  | 'georgian'
  | 'armenian'
  | 'ethiopic'
  | 'hangul'
  | 'kana'
  | 'han';

const SCRIPT_RANGES: readonly [number, number, Script][] = [
  [0x0041, 0x024f, 'latin'],
  [0x1e00, 0x1eff, 'latin'],
  [0x0370, 0x03ff, 'greek'],
  [0x0400, 0x052f, 'cyrillic'],
  [0x0530, 0x058f, 'armenian'],
  [0x0590, 0x05ff, 'hebrew'],
  [0x0600, 0x06ff, 'arabic'],
  [0x0750, 0x077f, 'arabic'],
  [0x0900, 0x097f, 'devanagari'],
  [0x0980, 0x09ff, 'bengali'],
  [0x0a00, 0x0a7f, 'gurmukhi'],
  [0x0a80, 0x0aff, 'gujarati'],
  [0x0b80, 0x0bff, 'tamil'],
  [0x0c00, 0x0c7f, 'telugu'],
  [0x0c80, 0x0cff, 'kannada'],
  [0x0d00, 0x0d7f, 'malayalam'],
  [0x0d80, 0x0dff, 'sinhala'],
  [0x0e00, 0x0e7f, 'thai'],
  [0x0e80, 0x0eff, 'lao'],
  [0x1000, 0x109f, 'myanmar'],
  [0x10a0, 0x10ff, 'georgian'],
  [0x1100, 0x11ff, 'hangul'],
  [0x1200, 0x137f, 'ethiopic'],
  [0x1780, 0x17ff, 'khmer'],
  [0x3040, 0x30ff, 'kana'],
  [0x3400, 0x9fff, 'han'],
  [0xac00, 0xd7af, 'hangul'],
  [0xf900, 0xfaff, 'han'],
];

function scriptOf(cp: number): Script | null {
  // Basic-Latin letters are the hot path.
  if ((cp >= 0x61 && cp <= 0x7a) || (cp >= 0x41 && cp <= 0x5a)) return 'latin';
  if (cp < 0xc0) return null;
  for (const [lo, hi, s] of SCRIPT_RANGES) if (cp >= lo && cp <= hi) return s;
  return null;
}

/** Scripts a page in a given primary language is legitimately written in. */
const LANGUAGE_SCRIPTS: Readonly<Record<string, readonly Script[]>> = {
  ru: ['cyrillic'], uk: ['cyrillic'], be: ['cyrillic'], bg: ['cyrillic'], mk: ['cyrillic'],
  kk: ['cyrillic', 'latin'], ky: ['cyrillic'], mn: ['cyrillic'], tg: ['cyrillic'],
  sr: ['cyrillic', 'latin'], az: ['latin', 'cyrillic', 'arabic'], uz: ['latin', 'cyrillic'],
  el: ['greek'],
  ar: ['arabic'], fa: ['arabic'], ur: ['arabic'], ps: ['arabic'], ku: ['arabic', 'latin'], sd: ['arabic'],
  he: ['hebrew'], yi: ['hebrew'],
  hi: ['devanagari'], mr: ['devanagari'], ne: ['devanagari'], sa: ['devanagari'],
  bn: ['bengali'], as: ['bengali'], pa: ['gurmukhi', 'arabic'], gu: ['gujarati'],
  ta: ['tamil'], te: ['telugu'], kn: ['kannada'], ml: ['malayalam'], si: ['sinhala'],
  th: ['thai'], lo: ['lao'], km: ['khmer'], my: ['myanmar'],
  ka: ['georgian'], hy: ['armenian'], am: ['ethiopic'], ti: ['ethiopic'],
  zh: ['han'], ja: ['han', 'kana'], ko: ['hangul', 'han'],
};

/** The language a script implies on its own, when it implies exactly one. */
const SCRIPT_LANGUAGE: Partial<Record<Script, string>> = {
  greek: 'el', hebrew: 'he', hangul: 'ko', kana: 'ja', han: 'zh', thai: 'th', lao: 'lo',
  khmer: 'km', myanmar: 'my', georgian: 'ka', armenian: 'hy', bengali: 'bn', gurmukhi: 'pa',
  gujarati: 'gu', tamil: 'ta', telugu: 'te', kannada: 'kn', malayalam: 'ml', sinhala: 'si',
  devanagari: 'hi', ethiopic: 'am', arabic: 'ar',
};

/** Normalise an `html[lang]` value to its primary subtag, or null. */
export function primaryLanguage(tag: string | null | undefined): string | null {
  const primary = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
  if (!/^[a-z]{2,3}$/.test(primary) || primary === 'und' || primary === 'mul') return null;
  // Legacy / alias primaries that name the same language.
  if (primary === 'iw') return 'he';
  if (primary === 'in') return 'id';
  if (primary === 'ji') return 'yi';
  if (primary === 'nb' || primary === 'nn') return 'no';
  return primary;
}

export interface ContentLanguage {
  /** Primary language the prose is written in, or null when not determinable. */
  detected: string | null;
  /**
   * True only when the page declares a language and the prose is, with
   * high confidence, written in a different one.
   */
  mismatch: boolean;
}

/**
 * Read the language of `text` and compare it with the declared
 * `html[lang]`. `text` should be the page's main-content prose (chrome
 * stripped) so a translated page under a shared menu is judged on its
 * own words.
 */
export function assessContentLanguage(text: string, declaredLang: string | null): ContentLanguage {
  const declared = primaryLanguage(declaredLang);
  const sample = text.length > SAMPLE_CHARS ? text.slice(0, SAMPLE_CHARS) : text;

  // ── 1. Script distribution ────────────────────────────────────────
  const scriptCounts = new Map<Script, number>();
  let letters = 0;
  for (const ch of sample) {
    const s = scriptOf(ch.codePointAt(0) ?? 0);
    if (!s) continue;
    letters++;
    scriptCounts.set(s, (scriptCounts.get(s) ?? 0) + 1);
  }
  if (letters < MIN_LETTERS) return { detected: null, mismatch: false };
  let dominant: Script | null = null;
  let dominantCount = 0;
  for (const [s, n] of scriptCounts) {
    if (n > dominantCount) {
      dominant = s;
      dominantCount = n;
    }
  }
  if (!dominant || dominantCount / letters < 0.6) return { detected: null, mismatch: false };
  // Japanese mixes kanji and kana; any real share of kana makes Han text Japanese.
  if (dominant === 'han' && (scriptCounts.get('kana') ?? 0) / letters > 0.1) dominant = 'kana';

  // ── 2. Function words (alphabetic scripts with word spacing) ──────
  let detected: string | null = null;
  let ratios: Map<string, number> | null = null;
  if (dominant === 'latin' || dominant === 'cyrillic') {
    const tokens = sample.toLowerCase().match(/\p{L}+/gu) ?? [];
    if (tokens.length >= MIN_TOKENS) {
      const hits = new Map<string, number>();
      for (const t of tokens) {
        const lang = DISTINCTIVE.get(t);
        if (lang) hits.set(lang, (hits.get(lang) ?? 0) + 1);
      }
      ratios = new Map([...hits].map(([l, n]) => [l, n / tokens.length]));
      let best: string | null = null;
      let bestRatio = 0;
      for (const [l, r] of ratios) {
        if (r > bestRatio) {
          best = l;
          bestRatio = r;
        }
      }
      if (best && bestRatio >= DETECTED_PRESENT_RATIO) detected = best;
    }
  } else {
    detected = SCRIPT_LANGUAGE[dominant] ?? null;
  }

  if (!declared) return { detected, mismatch: false };

  // ── 3. Compare with the declaration ───────────────────────────────
  const expectedScripts = LANGUAGE_SCRIPTS[declared] ?? (FUNCTION_WORDS[declared] ? ['latin'] : null);
  if (expectedScripts && !expectedScripts.includes(dominant)) {
    // Kana pages are Japanese; Han-only pages are fine for ja too.
    return { detected, mismatch: true };
  }
  // Same script: only the function-word evidence can tell languages
  // apart, and only for languages it knows on both sides.
  if (!ratios || !FUNCTION_WORDS[declared] || !detected || detected === declared) {
    return { detected, mismatch: false };
  }
  const declaredRatio = ratios.get(declared) ?? 0;
  const mismatch = declaredRatio < DECLARED_ABSENT_RATIO;
  return { detected, mismatch };
}
