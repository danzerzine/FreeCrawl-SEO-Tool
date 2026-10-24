import i18next from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { reportSummary } from './reportSummary.js';
import en from '../i18n/locales/en.json';
import ru from '../i18n/locales/ru.json';

beforeAll(async () => {
  await i18next.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, ru: { translation: ru } },
  });
});

describe('Reports header (B84b)', () => {
  it('counts URLs for an ordinary report', () => {
    expect(reportSummary('pages-per-dir', 3, 40, i18next.getFixedT('en'))).toBe('3 rows · 40 URLs');
  });

  it('counts mentions, not URLs, for Top Words', () => {
    const t = i18next.getFixedT('en');
    expect(reportSummary('top-words', 100, 250, t)).toBe('100 rows · 250 mentions');
    expect(reportSummary('top-words', 1, 1, t)).toBe('1 rows · 1 mention');
  });

  it('declines the Russian word for mentions', () => {
    const t = i18next.getFixedT('ru');
    expect(reportSummary('top-words', 100, 1, t)).toBe('Строк: 100 · 1 упоминание');
    expect(reportSummary('top-words', 100, 3, t)).toBe('Строк: 100 · 3 упоминания');
    expect(reportSummary('top-words', 100, 5, t)).toBe('Строк: 100 · 5 упоминаний');
  });
});
