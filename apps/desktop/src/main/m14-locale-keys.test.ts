import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.resolve(__dirname, '../renderer/src/i18n/locales');
const load = (l: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), 'utf8'));
const get = (o: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o);

const REASONS = [
  'NOTHING_FOUND', 'HOST_ERROR', 'REDIRECT_NOTSEARCHABLE', 'HTTP_ERROR', 'NOT_CANONICAL', 'NOT_MAIN_MIRROR',
  'PARSER_ERROR', 'ROBOTS_HOST_ERROR', 'ROBOTS_URL_ERROR', 'DUPLICATE', 'LOW_QUALITY', 'CLEAN_PARAMS', 'NO_INDEX', 'OTHER',
];

// Strings the M14 tabs show; the Russian UI must not fall back to English for them (P4, P5, P11, P12, P13, S11).
const KEYS = [
  'webmasterTab.excludedNote',
  'webmasterTab.colHttp',
  'webmasterTab.colTarget',
  ...REASONS.map((r) => `webmasterTab.reason.${r}`),
  'analyticsView.inspectionVerdict',
  'analyticsView.inspectionCoverage',
  'analyticsView.inspectionIndexing',
  'analyticsView.inspectionLastCrawl',
  'analyticsView.inspectionGoogleCanonical',
  'analyticsView.inspectionUserCanonical',
  'analyticsView.inspectionPageFetch',
  'analyticsView.inspectionCrawledAs',
  'analyticsView.inspectionSitemap',
  'analyticsView.inspectionSitemapHint',
  'analyticsView.inspectionLinkedFrom',
  'analyticsView.inspectionFirstShown',
  'analyticsView.inspectionReferringPage',
  'analyticsView.inspectionErrWarn',
  'ga4Tab.customNotPulledQuota',
  'ga4Tab.customNotPulledError',
  'gscTab.inspectCancelled',
];

describe('M14 locale keys', () => {
  for (const l of ['en', 'ru']) {
    it(`${l} has every new key`, () => {
      const json = load(l);
      expect(KEYS.filter((k) => typeof get(json, k) !== 'string')).toEqual([]);
    });
  }

  it('the excluded-count line and the progress line speak of removals / search events, not of all events as excluded pages', () => {
    for (const l of ['en', 'ru']) {
      const json = load(l);
      expect(get(json, 'webmasterTab.metaLine')).toContain('{{events}}');
      expect(String(get(json, 'webmasterTab.progressEvents'))).not.toMatch(/excluded pages|исключённых страниц/i);
    }
  });
});
