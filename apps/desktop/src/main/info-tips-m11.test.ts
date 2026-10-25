import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// M11: every new column tooltip and the page-script setting tooltips read in each locale.
const SRC = resolve(__dirname, '../renderer/src');
// Loaded by path: the renderer sources are not part of the main project's file list.
const { INFO_TIPS } = (await import(/* @vite-ignore */ resolve(SRC, 'i18n/info-tips.ts'))) as {
  INFO_TIPS: Record<string, Record<string, string>>;
};
const columns = readFileSync(resolve(SRC, 'tabs/columns.ts'), 'utf8');
const dialog = readFileSync(resolve(SRC, 'components/SettingsDialog.tsx'), 'utf8');

const COLUMN_KEYS = [
  'jsH1Changed', 'jsCanonicalChanged', 'jsLinksChanged', 'jsTextChanged',
  'consoleErrors', 'failedResources', 'consoleLog', 'renderDiff',
];
function columnInfo(key: string): string {
  const m = new RegExp(`  ${key}: \\{\\n(?:.*\\n)*?    info: ("(?:[^"\\\\]|\\\\.)*"),`).exec(columns);
  return JSON.parse(m![1] as string);
}
const tips = [
  ...COLUMN_KEYS.map(columnInfo),
  /info="(JavaScript that runs ONCE[^"]*)"/.exec(dialog)![1] as string,
  /info="(How long the page script may run[^"]*)"/.exec(dialog)![1] as string,
  /example="(5000 for a click and a short wait[^"]*)"/.exec(dialog)![1] as string,
];

describe('M11 tooltips are translated', () => {
  for (const [lang, table] of Object.entries(INFO_TIPS)) {
    it(lang, () => {
      for (const t of tips) {
        expect(table[t], `${lang}: ${t.slice(0, 50)}`).toBeTruthy();
        expect(table[t]).not.toBe(t);
      }
    });
  }
});

// B133: the title-length tooltip changed with the thresholds of module 5 and lost its translations.
describe('the title length tooltip is translated (B133)', () => {
  const tip = (/ {2}titleLength: \{\n(?:.*\n)*? {4}info: '((?:[^'\\]|\\.)*)',/.exec(columns)![1] as string).replace(/\\'/g, "'");
  it('names the thresholds setting', () => expect(tip).toMatch(/Thresholds/));
  for (const [lang, table] of Object.entries(INFO_TIPS)) {
    it(lang, () => {
      expect(table[tip], lang).toBeTruthy();
      expect(table[tip]).not.toBe(tip);
      expect(table[tip]).toContain('30–60');
    });
  }
});
