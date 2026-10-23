import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// B136: the ten page-signal columns in the desktop grid, Columns picker and Export dialog.
const SRC = resolve(__dirname, '../renderer/src');
const read = (p: string): string => readFileSync(resolve(SRC, p), 'utf8');
const { COLUMN_SPECS } = (await import(/* @vite-ignore */ resolve(SRC, 'tabs/columns.ts'))) as {
  COLUMN_SPECS: Record<string, { key: string; header: string; kind?: string; hiddenByDefault?: boolean; info?: string }[]>;
};
const { INFO_TIPS } = (await import(/* @vite-ignore */ resolve(SRC, 'i18n/info-tips.ts'))) as {
  INFO_TIPS: Record<string, Record<string, string>>;
};

const KEYS = [
  'hreflangOutsideHead',
  'titleOutsideHead',
  'descriptionOutsideHead',
  'metaRobotsOutsideHead',
  'ogNameAttr',
  'internalUtmLinks',
  'metaNoindexBots',
  'paginationLoop',
  'hreflangNotCanonical',
  'hreflangNoindexTargets',
];
const HEADERS = [
  'Hreflang Outside <head>',
  'Title Outside <head>',
  'Description Outside <head>',
  'Meta Robots Outside <head>',
  'OG Tag Uses name=',
  'Internal Link with UTM',
  'Noindex for Other Engines',
  'Pagination Loop',
  'Hreflang on Non-Canonical Page',
  'Noindex Alternate',
];
const LOCALES = ['az', 'es', 'fr', 'hi', 'it', 'ko', 'pt-BR', 'ru', 'tr', 'zh-CN'];

describe('B136 UI', () => {
  it('the internal tab offers the ten columns, Yes/No cells, hidden until chosen', () => {
    const internal = COLUMN_SPECS['internal']!;
    for (const [i, key] of KEYS.entries()) {
      const spec = internal.find((c) => c.key === key);
      expect(spec, key).toBeTruthy();
      expect(spec!.header).toBe(HEADERS[i]);
      expect(spec!.kind).toBe('yes-no');
      expect(spec!.hiddenByDefault).toBe(true);
      expect(spec!.info, key).toBeTruthy();
    }
  });

  it('the cell model paints the yes-no kind from the shared helper', () => {
    const model = read('grid/url-cell-model.ts');
    expect(model).toContain("'yes-no'");
    expect(model).toContain('urlSignalCell');
  });

  it('every locale file has every new header; ru and tr have the tooltips', () => {
    for (const lang of LOCALES) {
      const file = read(`i18n/labels/${lang}.ts`);
      for (const h of HEADERS) expect(file, `${lang} ${h}`).toContain(`'${h}':`);
      expect(file, lang).toContain("'Yes':");
      expect(file, lang).toContain("'No':");
    }
    const specs = COLUMN_SPECS['internal']!.filter((c) => KEYS.includes(c.key));
    for (const lang of ['ru', 'tr']) {
      for (const s of specs) expect(INFO_TIPS[lang]![s.info!], `${lang} ${s.key}`).toBeTruthy();
    }
  });

  it('Russian uses Да/Нет', () => {
    const ru = read('i18n/labels/ru.ts');
    expect(ru).toMatch(/'Yes': 'Да'/);
    expect(ru).toMatch(/'No': 'Нет'/);
  });
});
