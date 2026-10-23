import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.resolve(__dirname, '../renderer/src/i18n/locales');
const LOCALES = ['az', 'en', 'es', 'fr', 'hi', 'it', 'ko', 'pt-BR', 'ru', 'tr', 'zh-CN'];
const load = (l: string): Record<string, Record<string, string>> =>
  JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), 'utf8'));

/** Every `gscBq.*` / new `gscSettings.*` key the B91 UI asks for with t(). */
function usedKeys(): string[] {
  const src = path.resolve(__dirname, '../renderer/src');
  const files = [
    'components/GscBqPullDialog.tsx',
    'components/GscSettingsSection.tsx',
    'tabs/SearchConsoleTab.tsx',
  ].map((f) => fs.readFileSync(path.join(src, f), 'utf8'));
  const keys = new Set<string>();
  for (const s of files)
    for (const m of s.matchAll(/t\(\s*'(gscBq\.[A-Za-z]+|gscSettings\.(?:source\w*|bq\w+|rangeAll))'/g)) keys.add(m[1]!);
  return [...keys];
}

const placeholders = (s: string): string[] => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();

describe('B91 UI strings exist in all 11 locales', () => {
  const keys = usedKeys();
  it('finds the keys the UI uses', () => {
    expect(keys.length).toBeGreaterThan(20);
  });
  for (const l of LOCALES) {
    it(`${l} has every key with the same placeholders as en`, () => {
      const en = load('en');
      const d = load(l);
      for (const k of keys) {
        const [ns, key] = k.split('.') as [string, string];
        const v = d[ns]?.[key];
        expect(typeof v, `${l}:${k}`).toBe('string');
        expect(placeholders(v!), `${l}:${k}`).toEqual(placeholders(en[ns]![key]!));
      }
    });
  }
});
