import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// B168: the strings of the integration tabs (Search Console, GA4 and its settings, Yandex Webmaster, the
// Detail panel's Analytics view) are translated in every interface language, placeholders kept.
const DIR = resolve(__dirname, '../renderer/src/i18n/locales');
const BLOCKS = ['gscTab', 'ga4Tab', 'ga4Settings', 'webmasterTab', 'analyticsView'];
const LOCALES = ['az', 'es', 'fr', 'hi', 'it', 'ko', 'pt-BR', 'tr', 'zh-CN'];

type Tree = { [k: string]: string | Tree };
const flat = (t: Tree, p = ''): Record<string, string> =>
  Object.fromEntries(
    Object.entries(t).flatMap(([k, v]) => (typeof v === 'string' ? [[p + k, v]] : Object.entries(flat(v, `${p}${k}.`)))),
  );
const load = (l: string): Record<string, string> => flat(JSON.parse(readFileSync(resolve(DIR, `${l}.json`), 'utf8')) as Tree);
const en = load('en');

/** Product names and codes, the same in every language. */
const SAME_EVERYWHERE = new Set([
  'gscTab.title', 'gscTab.colUrl', 'gscTab.colCtr', 'ga4Tab.title', 'ga4Tab.colUrl', 'webmasterTab.title',
  'webmasterTab.colUrl', 'analyticsView.gscTitle', 'analyticsView.ga4Title', 'analyticsView.metricaTitle',
  'analyticsView.webmasterTitle', 'webmasterTab.reason.NO_INDEX',
]);
/** Words spelled as in English in that language. */
const SAME_IN: Record<string, string[]> = {
  fr: [
    'gscTab.colVerdict', 'gscTab.colImpr', 'gscTab.colPos', 'gscTab.summary', 'gscTab.colSitemaps', 'ga4Tab.colSessions',
    'ga4Tab.colEng', 'ga4Tab.summary', 'analyticsView.colSource', 'analyticsView.inspectionSitemap', 'ga4Settings.kindDimension',
    'analyticsView.inspectionVerdict',
  ],
  'pt-BR': ['gscTab.colStatus', 'ga4Tab.colStatus', 'gscTab.colSitemaps', 'analyticsView.inspectionSitemap'],
  az: ['gscTab.colStatus', 'ga4Tab.colStatus', 'analyticsView.inspectionSitemap'],
  es: ['gscTab.colSitemaps', 'analyticsView.inspectionSitemap', 'webmasterTab.seenNo'],
  it: ['ga4Settings.account', 'analyticsView.inspectionSitemap', 'webmasterTab.seenNo'],
};
const placeholders = (s: string): string[] => (s.match(/{{\w+}}/g) ?? []).sort();

describe('integration tab strings in every language (B168)', () => {
  const keys = Object.keys(en).filter((k) => BLOCKS.includes(k.split('.')[0]!));

  it.each(LOCALES)('%s translates every one, with the same placeholders', (l) => {
    const loc = load(l);
    const untranslated: string[] = [];
    for (const k of keys) {
      // Korean and Chinese have no singular plural form: their _other string covers it.
      if ((l === 'ko' || l === 'zh-CN') && k.endsWith('_one')) continue;
      const v = loc[k];
      if (v === undefined || v.trim() === '') {
        untranslated.push(`${k} (missing)`);
        continue;
      }
      expect(placeholders(v), `${l} ${k}`).toEqual(placeholders(en[k]!));
      if (v === en[k] && !SAME_EVERYWHERE.has(k) && !(SAME_IN[l] ?? []).includes(k)) untranslated.push(k);
    }
    expect(untranslated).toEqual([]);
  });
});
