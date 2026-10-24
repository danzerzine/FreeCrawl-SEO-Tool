import i18next from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  issueChangeRows,
  issueKeysText,
  issueCheckName,
  notComparableSummary,
} from './compareNames.js';
import en from '../i18n/locales/en.json';
import ru from '../i18n/locales/ru.json';

beforeAll(async () => {
  await i18next.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, ru: { translation: ru } },
  });
});

const tIn = (lng: string) => i18next.getFixedT(lng);

describe('Compare dialog names (B112, B117)', () => {
  it('translates an issue key to the sidebar names, in English and Russian', () => {
    expect(issueCheckName('issues:ttfb-slow', 'en')).not.toContain('issues:');
    const ru = issueCheckName('issues:ttfb-slow', 'ru');
    expect(ru).not.toBe(issueCheckName('issues:ttfb-slow', 'en'));
    expect(ru).not.toContain('ttfb-slow');
  });

  it('keeps an unknown key as it is', () => {
    expect(issueCheckName('issues:no-such-check', 'ru')).toBe('issues:no-such-check');
  });

  it('translates every key of a sample cell', () => {
    const cell = issueKeysText('issues:ttfb-slow issues:ttfb-very-slow', 'en');
    expect(cell).not.toContain('issues:');
    expect(cell).toContain(', ');
  });

  it('names the kinds and counts their pages, with Russian plural forms', () => {
    const nc = {
      content: { reason: 'x', urls: 12 },
      depth: { reason: 'x', urls: 1 },
    };
    expect(notComparableSummary(nc, tIn('en'), 'en')).toBe('Content (12 pages), Depth (1 page)');
    expect(notComparableSummary(nc, tIn('ru'), 'ru')).toBe('Контент (12 страниц), Глубина (1 страница)');
    expect(notComparableSummary({ content: { reason: 'x', urls: 3 } }, tIn('ru'), 'ru')).toBe(
      'Контент (3 страницы)',
    );
  });

  it('lists per-check appeared / resolved counts, most changed first', () => {
    const rows = issueChangeRows(
      {
        'issues:ttfb-slow': { appeared: 1, resolved: 2 },
        'issues:ttfb-very-slow': { appeared: 5, resolved: 0 },
      },
      'en',
    );
    expect(rows.map((r) => [r.key, r.appeared, r.resolved])).toEqual([
      ['issues:ttfb-very-slow', 5, 0],
      ['issues:ttfb-slow', 1, 2],
    ]);
    expect(rows[0]!.name).not.toContain('issues:');
  });
});
