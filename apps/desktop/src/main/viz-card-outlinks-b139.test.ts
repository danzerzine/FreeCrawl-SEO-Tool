import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// B139: the visualization card keeps the name "Unique Outlinks" and counts what the audit export's
// Unique Outlinks column counts: distinct internal targets (the number itself:
// packages/core/src/viz-unique-outlinks-b139.test.ts).
const SRC = resolve(__dirname, '../renderer/src');
const tab = readFileSync(resolve(SRC, 'tabs/VisualizationTab.tsx'), 'utf8');
const NAMES: Record<string, string> = {
  en: 'Unique Outlinks',
  ru: 'Уникальных исходящих ссылок',
  es: 'Enlaces salientes únicos',
  fr: 'Liens sortants uniques',
  tr: 'Benzersiz Dış Bağlantı',
};

describe('B139 visualization outlinks card', () => {
  it('is called Unique Outlinks and shows the unique internal outlinks of the page', () => {
    expect(tab).toContain(
      "label: t('viz.cardOutlinks', { defaultValue: 'Unique Outlinks' }),\n      value: node.uniqueOutlinks.toLocaleString(),",
    );
    for (const [lang, name] of Object.entries(NAMES)) {
      const v = JSON.parse(readFileSync(resolve(SRC, `i18n/locales/${lang}.json`), 'utf8')).viz.cardOutlinks as string;
      expect(v, lang).toBe(name);
    }
  });
});
