import { describe, expect, it } from 'vitest';
import { aggregateTopWords, createTopWordsAggregator } from './top-words.js';

describe('B84 Russian stopwords', () => {
  const texts = ['Купить кофе для Москвы', 'Кофе для Москвы дёшево'];

  it("locale 'ru' drops a 3-letter Russian function word that only the list can remove", () => {
    const rows = aggregateTopWords(texts, { locale: 'ru' });
    expect(rows.find((r) => r.word === 'для')).toBeUndefined();
    expect(rows.find((r) => r.word === 'кофе')).toEqual({ word: 'кофе', count: 2, pages: 2 });
  });

  it("locale 'en' keeps the same word", () => {
    const rows = aggregateTopWords(texts, { locale: 'en' });
    expect(rows.find((r) => r.word === 'для')).toMatchObject({ count: 2, pages: 2 });
  });

  it("'all' includes the Russian list; ё and е are one word for the lookup, the display stays as written", () => {
    const rows = aggregateTopWords(['всё дёшево', 'все дёшево'], { locale: 'all' });
    expect(rows.map((r) => r.word)).toEqual(['дёшево']);
  });
});

describe('B84 n-grams', () => {
  const grams = (texts: string[], n: 1 | 2 | 3) =>
    aggregateTopWords(texts, { locale: 'ru', n, minCount: 1 }).map((r) => r.word);

  it('n=2 never starts or ends a gram with a stopword; n=3 allows one inside', () => {
    const texts = ['Кофе для Москвы', 'Кофе для Москвы дёшево'];
    const two = grams(texts, 2);
    expect(two).not.toContain('кофе для');
    expect(two).not.toContain('для москвы');
    const three = aggregateTopWords(texts, { locale: 'ru', n: 3 });
    expect(three.find((r) => r.word === 'кофе для москвы')).toEqual({
      word: 'кофе для москвы',
      count: 2,
      pages: 2,
    });
  });

  it('counts a bigram of two content words; default minCount for n>=2 is 2', () => {
    const rows = aggregateTopWords(['Кофе Москвы', 'Кофе Москвы'], { locale: 'ru', n: 2 });
    expect(rows).toEqual([{ word: 'кофе москвы', count: 2, pages: 2 }]);
    expect(aggregateTopWords(['Кофе Москвы'], { locale: 'ru', n: 2 })).toEqual([]);
  });

  it('grams are built from the tokens the tokenizer returns: short words and numbers are dropped first', () => {
    const rows = aggregateTopWords(['Кофе в Москве', 'Кофе 24 Москве'], { locale: 'ru', n: 2 });
    expect(rows).toEqual([{ word: 'кофе москве', count: 2, pages: 2 }]);
  });

  it('n=1 output is the old output (regression pin)', () => {
    const texts = ['Red shoes for sale', 'Red shoes and boots', 'The sale of boots'];
    const expected = [
      { word: 'boots', count: 2, pages: 2 },
      { word: 'red', count: 2, pages: 2 },
      { word: 'sale', count: 2, pages: 2 },
      { word: 'shoes', count: 2, pages: 2 },
    ];
    expect(aggregateTopWords(texts, { locale: 'en' })).toEqual(expected);
    expect(aggregateTopWords(texts, { locale: 'en', n: 1 })).toEqual(expected);
  });
});

describe('B84 map cap with lossy pruning', () => {
  const LIMIT = 200_000;

  it('late phrase repeated 3 times survives 250 000 one-off bigrams; map never exceeds the limit; capped', () => {
    const agg = createTopWordsAggregator({ locale: 'en', n: 2 });
    for (let i = 0; i < 250_000; i++) agg.add(`early${i} phrase${i}`.replace(/\d/g, (d) => 'abcdefghij'[+d]!));
    expect(agg.size()).toBeLessThanOrEqual(LIMIT);
    for (let i = 0; i < 3; i++) agg.add('late phrase');
    const row = agg.result().find((r) => r.word === 'late phrase');
    expect(row).toBeDefined();
    expect(row!.count).toBeGreaterThanOrEqual(2);
    expect(agg.capped()).toBe(true);
    expect(agg.size()).toBeLessThanOrEqual(LIMIT);
  });

  it('r2 N1: a map full of grams seen twice does not freeze; a late phrase x3 is kept', () => {
    const agg = createTopWordsAggregator({ locale: 'en', n: 2 });
    const word = (i: number): string => 'w' + String(i).replace(/\d/g, (d) => 'abcdefghij'[+d]!);
    for (let i = 0; i < 160_000; i++) {
      agg.add(`${word(i)} ${word(i + 1_000_000)}`);
      agg.add(`${word(i)} ${word(i + 1_000_000)}`);
    }
    // one-offs fill the map to the limit; a prune of count-1 grams frees only 20 %
    for (let i = 0; i < 60_000; i++) agg.add(`${word(i + 2_000_000)} ${word(i + 3_000_000)}`);
    expect(agg.capped()).toBe(true);
    // the map fills up again and is pruned again: a rule that froze after the first weak prune never recovers
    for (let i = 0; i < 230_000; i++) agg.add(`${word(i + 4_000_000)} ${word(i + 5_000_000)}`);
    for (let i = 0; i < 3; i++) agg.add('late phrase');
    expect(agg.size()).toBeLessThanOrEqual(LIMIT);
    expect(agg.result().find((r) => r.word === 'late phrase')?.count).toBe(3);
    // keep adding after the weak prune: still no freeze
    for (let i = 0; i < 3; i++) agg.add('fresh phrase');
    expect(agg.result().find((r) => r.word === 'fresh phrase')?.count).toBe(3);
  });

  it('words (n=1) are not capped and report capped false', () => {
    const agg = createTopWordsAggregator({ locale: 'en' });
    agg.add('alpha beta');
    expect(agg.capped()).toBe(false);
  });
});
