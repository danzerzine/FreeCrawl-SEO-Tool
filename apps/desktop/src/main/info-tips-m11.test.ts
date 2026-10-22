import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INFO_TIPS } from '../renderer/src/i18n/info-tips';

// M11: every new column tooltip and the page-script setting tooltips read in each locale.
const SRC = resolve(__dirname, '../renderer/src');
const columns = readFileSync(resolve(SRC, 'tabs/columns.ts'), 'utf8');
const dialog = readFileSync(resolve(SRC, 'components/SettingsDialog.tsx'), 'utf8');

const COLUMN_KEYS = [
  'jsH1Changed', 'jsCanonicalChanged', 'jsLinksChanged', 'jsTextChanged',
  'consoleErrors', 'failedResources', 'consoleLog', 'renderDiff',
];
function columnInfo(key: string): string {
  const m = new RegExp(`  ${key}: \\{\\n(?:.*\\n)*?    info: ("(?:[^"\\\\]|\\\\.)*"),`).exec(columns);
  return JSON.parse(m![1]);
}
const tips = [
  ...COLUMN_KEYS.map(columnInfo),
  /info="(JavaScript that runs ONCE[^"]*)"/.exec(dialog)![1],
  /info="(How long the page script may run[^"]*)"/.exec(dialog)![1],
  /example="(5000 for a click and a short wait[^"]*)"/.exec(dialog)![1],
];

describe('M11 tooltips are translated', () => {
  for (const [lang, table] of Object.entries(INFO_TIPS)) {
    it(lang, () => {
      for (const t of tips) {
        expect(table![t], `${lang}: ${t.slice(0, 50)}`).toBeTruthy();
        expect(table![t]).not.toBe(t);
      }
    });
  }
});
