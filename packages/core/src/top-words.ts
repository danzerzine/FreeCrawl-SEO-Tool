import { sectionOf } from '@freecrawl/db';

/**
 * Word-frequency aggregation for the "Top Words" report. Pure / sync /
 * data-only — the DB layer feeds raw text strings (titles, descriptions,
 * H1s, optionally body text) and gets back a deduped frequency map.
 *
 * Stopwords are bundled English, Turkish and Russian. Adding more locales is a matter of dropping another set
 * into `STOPWORDS_BY_LOCALE`. Detection is intentionally absent: if the
 * site mixes languages we just union all enabled stopword sets.
 *
 * Tokenisation uses Unicode-aware `\p{L}` so Turkish (ç, ğ, ı, ş, ü, ö),
 * accented Western European, and Cyrillic all produce clean tokens
 * without us having to maintain a per-language regex.
 */

const STOPWORDS_EN = new Set<string>([
  // articles, conjunctions, common prepositions
  'the', 'and', 'but', 'for', 'are', 'was', 'were', 'with', 'that', 'this',
  'these', 'those', 'from', 'have', 'has', 'had', 'will', 'would', 'should',
  'can', 'could', 'may', 'might', 'must', 'into', 'onto', 'upon', 'over',
  'under', 'about', 'after', 'before', 'between', 'through', 'during',
  'where', 'when', 'while', 'because', 'although', 'though', 'than', 'then',
  'too', 'very', 'just', 'only', 'also', 'still', 'such', 'some', 'any',
  'each', 'every', 'all', 'most', 'more', 'less', 'much', 'many', 'few',
  'other', 'another', 'same', 'own', 'here', 'there', 'what', 'which',
  'who', 'whom', 'whose', 'why', 'how', 'not', 'nor', 'either', 'neither',
  'both', 'not', 'yet', 'without', 'within', 'against', 'across', 'among',
  // pronouns
  'they', 'them', 'their', 'his', 'her', 'hers', 'its', 'our', 'ours',
  'your', 'yours', 'mine', 'myself', 'yourself', 'himself', 'herself',
  'itself', 'ourselves', 'themselves', 'you', 'she', 'him', 'one',
  // auxiliary / very common verbs
  'been', 'being', 'doing', 'does', 'done', 'goes', 'gone', 'come', 'came',
  'take', 'taken', 'took', 'make', 'made', 'get', 'got', 'gets',
  'know', 'knew', 'known', 'see', 'saw', 'seen', 'say', 'said',
  // common short
  'use', 'used', 'using', 'two', 'three', 'four', 'five',
  'new', 'now', 'way', 'day', 'year', 'time', 'thing',
]);

const STOPWORDS_TR = new Set<string>([
  // bağlaçlar, yardımcı fiiller, çok geçen kısa kelimeler
  've', 'veya', 'ile', 'ama', 'fakat', 'ancak', 'çünkü', 'için', 'gibi',
  'kadar', 'değil', 'daha', 'çok', 'tüm', 'tüm', 'hepsi', 'bazı', 'her',
  'hiç', 'şey', 'yine', 'hep', 'hep', 'eğer', 'ise', 'iken', 'fakat',
  'lakin', 'oysa', 'oysaki', 'üzere', 'önce', 'sonra', 'arada',
  // zamirler
  'ben', 'sen', 'biz', 'siz', 'onlar', 'kim', 'ne', 'nasıl', 'neden',
  'niçin', 'kendi', 'kendisi', 'kendileri', 'şu', 'şunu', 'şunlar',
  'bu', 'bunu', 'bunlar', 'bunların',
  // yapılar
  'olan', 'olan', 'olduğu', 'olmak', 'oldu', 'olur', 'olabilir',
  'oldu', 'eden', 'edilen', 'eden',
  // bağlaç + edat varyantları
  'göre', 'rağmen', 'doğru', 'karşı', 'beri', 'kez', 'kere', 'defa',
  'an', 'biri', 'birisi', 'birkaç', 'birçok', 'kimse', 'herkes',
  // sayılar / zaman
  'bir', 'iki', 'üç', 'dört', 'beş', 'yıl', 'gün', 'ay', 'saat',
  'şimdi', 'sonra', 'önce', 'bugün', 'yarın', 'dün',
  // vs
  'var', 'yok', 'mı', 'mi', 'mu', 'mü', 'da', 'de', 'ki',
]);

/** Each word with `ё` is listed with `е` too, so a text typed without the dots still matches. */
function withYoForms(words: string[]): Set<string> {
  return new Set(words.flatMap((w) => (w.includes('ё') ? [w, w.replace(/ё/g, 'е')] : [w])));
}

const STOPWORDS_RU = withYoForms([
  // предлоги, союзы, частицы
  'для', 'без', 'над', 'под', 'при', 'про', 'через', 'между', 'перед', 'после',
  'около', 'возле', 'вокруг', 'против', 'среди', 'кроме', 'вместо', 'ради',
  'из-за', 'как', 'так', 'что', 'чтобы', 'или', 'либо', 'тоже', 'также', 'если',
  'когда', 'пока', 'потому', 'поэтому', 'чем', 'хотя', 'будто', 'словно', 'даже',
  'лишь', 'только', 'ещё', 'уже', 'вот', 'вон', 'ведь', 'бы', 'нет', 'нею',
  'пусть', 'разве', 'неужели', 'именно', 'почти', 'очень', 'можно', 'нужно',
  // местоимения
  'это', 'эта', 'эти', 'этот', 'этих', 'этим', 'этом', 'этой', 'этого', 'этому',
  'эту', 'тот', 'того', 'той', 'том', 'тем', 'те', 'тех', 'там', 'тут', 'здесь',
  'где', 'куда', 'откуда', 'кто', 'кого', 'кому', 'кем', 'чей', 'чья', 'чьё',
  'чьи', 'какой', 'какая', 'какое', 'какие', 'каких', 'каким', 'каком',
  'который', 'которая', 'которое', 'которые', 'которых', 'которым', 'которой',
  'какого', 'сам', 'сама', 'само', 'сами', 'свой', 'своя', 'своё', 'свои',
  'своих', 'своей', 'своего', 'всё', 'все', 'всех', 'всем', 'всей', 'весь',
  'вся', 'его', 'её', 'их', 'ему', 'ней', 'ним', 'них', 'нему', 'они', 'она',
  'оно', 'мы', 'вы', 'ты', 'меня', 'мне', 'мной', 'тебя', 'тебе', 'нас', 'нам',
  'вас', 'вам', 'нами', 'вами', 'наш', 'наша', 'наше', 'наши', 'ваш', 'ваша',
  'ваше', 'ваши', 'мой', 'моя', 'моё', 'мои', 'твой', 'твоя', 'твои',
  // частые глаголы и слова-связки
  'быть', 'был', 'была', 'было', 'были', 'будет', 'будут', 'есть', 'суть',
  'является', 'являются', 'может', 'могут', 'можете', 'должен', 'должна',
  'должны', 'стал', 'стала', 'стало', 'стали', 'стать', 'иметь', 'имеет',
  'один', 'одна', 'одно', 'одни', 'два', 'две', 'три', 'более', 'менее',
  'других', 'другие', 'другой', 'другая', 'другое', 'каждый', 'каждая',
  'каждое', 'любой', 'любая', 'любое', 'многие', 'многих', 'такой', 'такая',
  'такое', 'такие', 'таких', 'нибудь', 'либо', 'чего', 'чему', 'чём',
]);

export type TopWordsLocale = 'en' | 'tr' | 'ru' | 'all';

const STOPWORDS_BY_LOCALE: Record<TopWordsLocale, Set<string>> = {
  en: STOPWORDS_EN,
  tr: STOPWORDS_TR,
  ru: STOPWORDS_RU,
  // Default — most crawls hit either English or Turkish text, often
  // mixed (Turkish e-commerce sites sprinkle English brand names). The
  // union catches the most common stopwords regardless of language.
  all: new Set<string>([...STOPWORDS_EN, ...STOPWORDS_TR, ...STOPWORDS_RU]),
};

/** `ё` and `е` are one letter for the lookup only; the counted word keeps its spelling. */
function isStopword(stopwords: Set<string>, tok: string): boolean {
  return stopwords.has(tok) || (tok.includes('ё') && stopwords.has(tok.replace(/ё/g, 'е')));
}

export interface TopWordsRow {
  word: string;
  /** Total occurrences across all input strings. */
  count: number;
  /** Number of distinct input strings (≈ pages) that contained the word. */
  pages: number;
}

export interface TopWordsOptions {
  /** Max rows to return (default 100, hard cap 1000). */
  limit?: number;
  /** Minimum word length (default 3 — drops 1–2 char noise). */
  minLength?: number;
  /** Stopword set to apply (default `all`). */
  locale?: TopWordsLocale;
  /**
   * Words (1, default) or phrases of 2-3 consecutive tokens (B84). A phrase
   * neither starts nor ends with a stopword; stopwords inside it stay.
   */
  n?: 1 | 2 | 3;
  /** Rows with fewer occurrences are left out of `result()`. Default 1 for words, 2 for phrases. */
  minCount?: number;
  /**
   * Phrase map limit (default {@link DEFAULT_MAX_GRAMS}); words (n=1) are not capped. When the map
   * is full, rare phrases are dropped (lossy counting) and the aggregator reports `capped`.
   */
  maxGrams?: number;
}

/** Default phrase map limit of one aggregator (a site, or one section when there are few). */
export const DEFAULT_MAX_GRAMS = 200_000;

/**
 * Tokenise a string into lowercase words, dropping numbers + punctuation
 * + tokens shorter than `minLength`. Unicode `\p{L}` covers Latin,
 * Turkish, Cyrillic, Greek, etc. without us needing per-locale regex.
 */
export function tokenizeForTopWords(text: string, minLength: number): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /[\p{L}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length >= minLength) out.push(m[0].toLowerCase());
  }
  return out;
}

/**
 * Aggregate word frequencies from a stream of input strings (one per
 * page, typically `title + " " + metaDescription + " " + h1`). Returns
 * the top-N most frequent non-stopword tokens with both raw count and
 * page-coverage count (how many distinct strings contained the word).
 *
 * The page-coverage signal lets the UI distinguish "popular topic
 * across the site" from "one page repeats a word a hundred times".
 */
export function aggregateTopWords(
  texts: Iterable<string>,
  opts: TopWordsOptions = {},
): TopWordsRow[] {
  const agg = createTopWordsAggregator(opts);
  for (const text of texts) agg.add(text);
  return agg.result();
}

/** Incremental form of {@link aggregateTopWords} for sources that arrive asynchronously. */
export interface TopWordsAggregator {
  /** Counts one source string (one page). */
  add(text: string): void;
  /** Top rows so far, sorted by count. */
  result(): TopWordsRow[];
  /** True once rare phrases were dropped to stay inside the map limit: counts are approximate. */
  capped(): boolean;
  /** Distinct words or phrases held now. */
  size(): number;
}

export function createTopWordsAggregator(opts: TopWordsOptions = {}): TopWordsAggregator {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
  const minLength = Math.max(1, Math.min(10, opts.minLength ?? 3));
  const stopwords = STOPWORDS_BY_LOCALE[opts.locale ?? 'all'];

  const n = opts.n === 2 || opts.n === 3 ? opts.n : 1;
  const minCount = Math.max(1, opts.minCount ?? (n === 1 ? 1 : 2));

  // Two parallel maps: total frequency, and per-page frequency
  // (incremented at most once per source string). Keeping them
  // separate avoids re-tokenising or threading a Set through the
  // hot path.
  const total = new Map<string, number>();
  const pages = new Map<string, number>();
  const seenInThisPage = new Set<string>();

  const maxGrams = Math.max(4, opts.maxGrams ?? DEFAULT_MAX_GRAMS);
  let wasPruned = false;
  // Lossy counting: the count at or below which a prune evicts; it only rises.
  let threshold = 1;

  /**
   * Frees at least 25 % of the limit: evicts everything seen `threshold` times or less, and raises
   * the threshold step by step until the map is at most 75 % full. Adding never stops.
   */
  const prune = (): void => {
    wasPruned = true;
    const histogram = new Map<number, number>();
    for (const c of total.values()) histogram.set(c, (histogram.get(c) ?? 0) + 1);
    const goal = Math.floor(maxGrams * 0.75);
    const counts = [...histogram.keys()].sort((a, b) => a - b);
    let left = total.size;
    for (const c of counts) {
      if (c > threshold && left <= goal) break;
      left -= histogram.get(c)!;
      threshold = Math.max(threshold, c);
    }
    for (const [key, c] of total) {
      if (c > threshold) continue;
      total.delete(key);
      pages.delete(key);
      seenInThisPage.delete(key);
    }
  };

  const count = (key: string): void => {
    let current = total.get(key);
    if (current === undefined) {
      if (n > 1 && total.size >= maxGrams) prune();
      current = 0;
    }
    total.set(key, current + 1);
    if (!seenInThisPage.has(key)) {
      pages.set(key, (pages.get(key) ?? 0) + 1);
      seenInThisPage.add(key);
    }
  };

  return {
    add(text: string): void {
      const tokens = tokenizeForTopWords(text, minLength);
      seenInThisPage.clear();
      if (n === 1) {
        for (const tok of tokens) {
          if (isStopword(stopwords, tok)) continue;
          count(tok);
        }
        return;
      }
      for (let i = 0; i + n <= tokens.length; i++) {
        if (isStopword(stopwords, tokens[i]!) || isStopword(stopwords, tokens[i + n - 1]!)) continue;
        count(tokens.slice(i, i + n).join(' '));
      }
    },
    capped: () => wasPruned,
    size: () => total.size,
    result(): TopWordsRow[] {
      return [...total.entries()]
        .filter(([, c]) => c >= minCount)
        .map(([word, c]) => ({
          word,
          count: c,
          pages: pages.get(word) ?? 0,
        }))
        .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
        .slice(0, limit);
    },
  };
}

/** The folder a page belongs to (`news`, `news/a` at depth 2, `/` for the root); see `sectionOf` in the db package. */
export { sectionOf };

/** Most sections a by-section report keeps; the smaller ones are summed into {@link OTHER_SECTION}. */
export const MAX_SECTIONS = 50;
export const OTHER_SECTION = '(other)';
const MIN_GRAMS_PER_SECTION = 20_000;

export interface SectionedTopWordsOptions extends TopWordsOptions {
  /** Folder depth, 1 (default) or 2. */
  sectionDepth?: number;
  /** Pages per section of the whole corpus: decides which {@link MAX_SECTIONS} sections are kept. */
  sectionPages: ReadonlyMap<string, number>;
}

export interface SectionTopWords {
  section: string;
  rows: TopWordsRow[];
  capped: boolean;
}

export interface SectionedTopWords {
  /** Counts one page's text under its section. */
  add(url: string, text: string): void;
  /** One block per section, ordered by name; `(other)` holds every section that was not kept. */
  result(): SectionTopWords[];
  /** Phrase map limit of each section: the shared 200 000 split between them, never below 20 000. */
  readonly limitPerSection: number;
}

/**
 * One aggregator per section. The sections kept are the {@link MAX_SECTIONS} with the most pages;
 * the phrase map of each gets `max(20 000, total / sections)`, so the total stays near 1 M grams.
 */
export function createSectionedTopWords(opts: SectionedTopWordsOptions): SectionedTopWords {
  const depth = opts.sectionDepth ?? 1;
  const ranked = [...opts.sectionPages.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const kept = new Set(ranked.slice(0, MAX_SECTIONS).map(([name]) => name));
  const blocks = kept.size + (ranked.length > MAX_SECTIONS ? 1 : 0);
  const limitPerSection = Math.max(
    MIN_GRAMS_PER_SECTION,
    Math.floor((opts.maxGrams ?? DEFAULT_MAX_GRAMS) / Math.max(1, blocks)),
  );
  const aggregators = new Map<string, TopWordsAggregator>();
  return {
    limitPerSection,
    add(url: string, text: string): void {
      const own = sectionOf(url, depth);
      const section = own !== null && kept.has(own) ? own : OTHER_SECTION;
      let agg = aggregators.get(section);
      if (!agg) {
        agg = createTopWordsAggregator({ ...opts, maxGrams: limitPerSection });
        aggregators.set(section, agg);
      }
      agg.add(text);
    },
    result(): SectionTopWords[] {
      return [...aggregators.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([section, agg]) => ({ section, rows: agg.result(), capped: agg.capped() }));
    },
  };
}
