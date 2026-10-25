import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// B139: the visualization card counts internal and external targets, the audit export's "Unique Outlinks"
// counts internal ones only, so the card no longer carries that name.
const SRC = resolve(__dirname, '../renderer/src');
const tab = readFileSync(resolve(SRC, 'tabs/VisualizationTab.tsx'), 'utf8');

describe('B139 visualization outlinks card', () => {
  it('is not called "Unique Outlinks" in any language it is translated in', () => {
    expect(tab).not.toContain("defaultValue: 'Unique Outlinks'");
    for (const lang of ['en', 'ru', 'es', 'fr', 'tr']) {
      const v = JSON.parse(readFileSync(resolve(SRC, `i18n/locales/${lang}.json`), 'utf8')).viz.cardOutlinks as string;
      expect(v, lang).not.toMatch(/Unique Outlinks|Уникальных исходящих|Enlaces salientes únicos|Liens sortants uniques|Benzersiz Dış/);
      expect(v.length, lang).toBeGreaterThan(10);
    }
  });
});
