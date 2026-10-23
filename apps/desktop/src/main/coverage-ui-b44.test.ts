import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// B44: the Settings checkbox, the four grid columns, the URL Details line and the Russian text.
const SRC = resolve(__dirname, '../renderer/src');
const read = (p: string): string => readFileSync(resolve(SRC, p), 'utf8');
const { INFO_TIPS } = (await import(/* @vite-ignore */ resolve(SRC, 'i18n/info-tips.ts'))) as {
  INFO_TIPS: Record<string, Record<string, string>>;
};
const columns = read('tabs/columns.ts');
const panel = read('components/BottomDetailPanel.tsx');
const dialog = read('components/SettingsDialog.tsx');
const mainIndex = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');

describe('B44 UI', () => {
  it('the checkbox is wired to jsRender.coverage in the form, the load, the save and the main-process parse', () => {
    expect(dialog.match(/jsCoverage/g)!.length).toBeGreaterThanOrEqual(4);
    expect(dialog).toContain('coverage: form.jsCoverage');
    expect(mainIndex).toContain('coverage: parsed.jsRender?.coverage');
    for (const lang of ['en', 'ru']) {
      const r = JSON.parse(read(`i18n/locales/${lang}.json`)).settingsPanels.rendering as Record<string, string>;
      expect(r['coverage'], lang).toBeTruthy();
    }
  });

  it('the four grid columns start hidden and are in the Internal grid', () => {
    for (const key of ['cssBytes', 'cssUnusedBytes', 'jsBytes', 'jsUnusedBytes']) {
      const m = new RegExp(`  ${key}: \\{\\n(?:.*\\n)*?    hiddenByDefault: true,`).exec(columns);
      expect(m, key).not.toBeNull();
      expect(columns, key).toContain(`COL.${key},`);
    }
  });

  it('URL Details shows "Unused CSS" and "Unused JS" lines as X of Y KB (Z %)', () => {
    expect(panel).toContain("['Unused CSS', coverageText(row.cssUnusedBytes, row.cssBytes)]");
    expect(panel).toContain("['Unused JS', coverageText(row.jsUnusedBytes, row.jsBytes)]");
    expect(panel).toContain('function coverageText');
  });

  it('tooltips and labels read in Russian', () => {
    const tips = [
      /info: ("Size of the stylesheets the page loaded[^"]*"),/.exec(columns)![1] as string,
      /info: ("Part of CSS Bytes[^"]*"),/.exec(columns)![1] as string,
      /info: ("Size of the scripts the page loaded[^"]*"),/.exec(columns)![1] as string,
      /info: ("Part of JS Bytes[^"]*"),/.exec(columns)![1] as string,
      /info="(Measures how much CSS and JavaScript[^"]*)"/.exec(dialog)![1] as string,
      /example="(On to find heavy unused code[^"]*)"/.exec(dialog)![1] as string,
    ].map((t) => (t.startsWith('"') ? (JSON.parse(t) as string) : t));
    for (const t of tips) expect(INFO_TIPS['ru']![t], t.slice(0, 40)).toBeTruthy();
    const ru = read('i18n/labels/ru.ts');
    for (const l of ['CSS Bytes', 'Unused CSS Bytes', 'JS Bytes', 'Unused JS Bytes', 'Unused CSS', 'Unused JS']) {
      expect(ru.includes(`'${l}':`), l).toBe(true);
    }
  });
});
