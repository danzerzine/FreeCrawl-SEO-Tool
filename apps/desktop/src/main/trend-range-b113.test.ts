import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// B113: the arrow tooltip names the two finished crawls it compares.
const SRC = resolve(__dirname, '../renderer/src');
const sidebar = readFileSync(resolve(SRC, 'components/OverviewSidebar.tsx'), 'utf8');

describe('B113 trend tooltip', () => {
  it('adds the range of the two finished crawls to the previous-crawl text', () => {
    expect(sidebar).toContain("t('sidebar.trendRange'");
    expect(sidebar).toContain('trend.currentFinishedAt');
    expect(sidebar).toMatch(/}\) \+ range \+ version;/);
  });
  it('en and ru say a crawl stopped by hand is not compared', () => {
    for (const [lang, word] of [['en', 'stopped by hand'], ['ru', 'вручную']] as const) {
      const s = JSON.parse(readFileSync(resolve(SRC, `i18n/locales/${lang}.json`), 'utf8')).sidebar.trendRange as string;
      expect(s, lang).toContain(word);
      expect(s, lang).toContain('{{from}}');
      expect(s, lang).toContain('{{to}}');
    }
  });
});
