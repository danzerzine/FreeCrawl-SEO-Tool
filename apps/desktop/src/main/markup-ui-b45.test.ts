import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// B45: the Settings checkbox, the two grid columns and their Russian text.
const SRC = resolve(__dirname, '../renderer/src');
const read = (p: string): string => readFileSync(resolve(SRC, p), 'utf8');
const { INFO_TIPS } = (await import(/* @vite-ignore */ resolve(SRC, 'i18n/info-tips.ts'))) as {
  INFO_TIPS: Record<string, Record<string, string>>;
};
const columns = read('tabs/columns.ts');
const dialog = read('components/SettingsDialog.tsx');

describe('B45 UI', () => {
  it('en and ru have the Settings label and hint', () => {
    for (const lang of ['en', 'ru']) {
      const crawler = JSON.parse(read(`i18n/locales/${lang}.json`)).settingsPanels.crawler as Record<string, string>;
      expect(crawler.markupValidation, lang).toBeTruthy();
      expect(crawler.markupValidationHint, lang).toBeTruthy();
    }
    expect(JSON.parse(read('i18n/locales/ru.json')).settingsPanels.crawler.markupValidation).not.toBe(
      JSON.parse(read('i18n/locales/en.json')).settingsPanels.crawler.markupValidation,
    );
  });

  it('the checkbox is wired to markupValidation in the form, the load and the save', () => {
    expect(dialog.match(/markupValidation/g)!.length).toBeGreaterThanOrEqual(5);
  });

  it('both grid columns start hidden', () => {
    for (const key of ['markupErrors', 'markupCodes']) {
      const m = new RegExp(`  ${key}: \\{\\n(?:.*\\n)*?    hiddenByDefault: true,`).exec(columns);
      expect(m, key).not.toBeNull();
    }
  });

  it('the tooltips of the columns and the setting read in Russian', () => {
    const tips = [
      /info: ("HTML markup errors found[^"]*"),/.exec(columns)![1] as string,
      /info: ("The error codes behind Markup Errors[^"]*"),/.exec(columns)![1] as string,
      /info='(Counts HTML markup errors per page[^']*)'/.exec(dialog)![1] as string,
      /example="(Leave off for speed; on to find broken markup[^"]*)"/.exec(dialog)![1] as string,
    ].map((t) => (t.startsWith('"') ? (JSON.parse(t) as string) : t));
    for (const t of tips) {
      expect(INFO_TIPS['ru']![t], t.slice(0, 40)).toBeTruthy();
    }
  });
});
