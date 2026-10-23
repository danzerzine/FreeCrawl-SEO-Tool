import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// B43: the grid columns, the rendered-cookie table of the Cookies tab and the Russian text.
const SRC = resolve(__dirname, '../renderer/src');
const read = (p: string): string => readFileSync(resolve(SRC, p), 'utf8');
const { INFO_TIPS } = (await import(/* @vite-ignore */ resolve(SRC, 'i18n/info-tips.ts'))) as {
  INFO_TIPS: Record<string, Record<string, string>>;
};
const columns = read('tabs/columns.ts');
const panel = read('components/BottomDetailPanel.tsx');
const dialog = read('components/SettingsDialog.tsx');

describe('B43 UI', () => {
  it('the three grid columns start hidden', () => {
    for (const key of ['cookiesTotal', 'cookiesTruncated', 'cookiesJson']) {
      const m = new RegExp(`  ${key}: \\{\\n(?:.*\\n)*?    hiddenByDefault: true,`).exec(columns);
      expect(m, key).not.toBeNull();
      expect(columns, key).toContain(`COL.${key},`);
    }
  });

  it('the Cookies tab shows the recorded list with the "Showing N of M" note and never a value column', () => {
    expect(panel).toContain('function RenderedCookieList');
    expect(panel).toContain('<RenderedCookieList row={detail.row} />');
    expect(panel).toContain('cookies.recordedShowing');
    const fn = /function RenderedCookieList[\s\S]*?\n}\n/.exec(panel)![0];
    expect(fn).not.toMatch(/\.value|'Value'/);
    for (const lang of ['en', 'ru']) {
      const j = JSON.parse(read(`i18n/locales/${lang}.json`)) as { cookies: Record<string, string> };
      for (const k of ['recordedTitle', 'recordedShowing', 'setByHeader', 'setByScript', 'session']) {
        expect(j.cookies[k], `${lang} ${k}`).toBeTruthy();
      }
    }
  });

  it('Russian tooltips for the columns and the setting', () => {
    const tips = [
      /info: ("How many cookies the page set[^"]*"),/.exec(columns)![1] as string,
      /info: ("1 when the page set more cookies than the list holds[^"]*"),/.exec(columns)![1] as string,
      /info: ("The cookie list behind Cookies[^"]*"),/.exec(columns)![1] as string,
      /info="(Lists the cookies each page sets[^"]*)"/.exec(dialog)![1] as string,
      /example="(On to find third-party and tracking cookies[^"]*)"/.exec(dialog)![1] as string,
    ].map((t) => (t.startsWith('"') ? (JSON.parse(t) as string) : t));
    for (const t of tips) expect(INFO_TIPS['ru']![t], t.slice(0, 40)).toBeTruthy();
  });

  it('the grid labels read in Russian', () => {
    const ru = read('i18n/labels/ru.ts');
    for (const l of ['Cookies', 'Cookies Truncated', 'Cookies JSON']) expect(ru.includes(`'${l}':`) || ru.includes(`\n  ${l}:`), l).toBe(true);
  });
});
