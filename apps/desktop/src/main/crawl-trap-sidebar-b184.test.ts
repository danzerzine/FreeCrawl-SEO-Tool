import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// B184: the trap notice shows its details in the panel and never the raw `host/(root)` key.
const SRC = resolve(__dirname, '../renderer/src');
const sidebar = readFileSync(resolve(SRC, 'components/OverviewSidebar.tsx'), 'utf8');

describe('B184 crawl-trap notice', () => {
  it('shows the summary as visible text and reads the root key through a label', () => {
    expect(sidebar).toMatch(/key: 'crawlTrap',[\s\S]*?note: trapSummary,/);
    expect(sidebar).toContain('key: trapKeyLabel(f.key)');
    expect(sidebar).not.toContain('key: f.key,');
  });

  it('en and ru carry the root label and the share', () => {
    for (const lang of ['en', 'ru']) {
      const s = JSON.parse(readFileSync(resolve(SRC, `i18n/locales/${lang}.json`), 'utf8')).sidebar;
      expect(s.siteCrawlTrapRoot, lang).toBeTruthy();
      expect(s.siteCrawlTrapItem, lang).toContain('{{share}}');
      expect(s.siteCrawlTrapItemSitemap, lang).toContain('{{share}}');
    }
  });
});
