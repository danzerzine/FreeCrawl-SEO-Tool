import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SEO_THRESHOLDS, ISSUE_CATEGORIES } from '@freecrawl/shared-types';

// B44b: the two coverage checks in the sidebar (Internal grid), their thresholds in
// Settings → Issues → Thresholds, and the Russian text.
const SRC = resolve(__dirname, '../renderer/src');
const read = (p: string): string => readFileSync(resolve(SRC, p), 'utf8');
const store = read('store.ts');
const dialog = read('components/SettingsDialog.tsx');
const ruLabels = read('i18n/labels/ru.ts');
const locale = (l: string) =>
  JSON.parse(read(`i18n/locales/${l}.json`)) as { settingsPanels: { thresholds: Record<string, string> } };

describe('B44b UI', () => {
  it('both checks are issue categories with a sidebar entry that opens the Internal grid', () => {
    for (const [cat, label] of [
      ['issues:css-unused', 'Unused CSS (>{{cssUnusedPct}} %)'],
      ['issues:js-unused', 'Unused JavaScript (>{{jsUnusedPct}} %)'],
    ] as const) {
      expect(ISSUE_CATEGORIES as readonly string[]).toContain(cat);
      expect(store).toContain(`{ label: '${label}', category: '${cat}' }`);
      expect(ruLabels).toContain(`'${label}':`);
    }
    expect(store).toContain("if (cat === 'issues:css-unused' || cat === 'issues:js-unused') return 'internal';");
  });

  it('the thresholds are fields of the Thresholds panel, in English and Russian', () => {
    expect(DEFAULT_SEO_THRESHOLDS).toMatchObject({ cssUnusedPct: 50, jsUnusedPct: 50 });
    for (const key of ['cssUnusedPct', 'jsUnusedPct']) {
      expect(dialog).toContain(`{ key: '${key}', label: `);
      const en = locale('en').settingsPanels.thresholds[key];
      const ru = locale('ru').settingsPanels.thresholds[key];
      expect(en, key).toBeTruthy();
      expect(ru, key).toMatch(/[а-я]/);
    }
  });
});
