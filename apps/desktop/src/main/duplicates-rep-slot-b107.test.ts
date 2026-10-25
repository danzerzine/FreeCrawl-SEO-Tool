import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// B107: the "representative" label sits in a fixed-width slot present on every member row.
const SRC = resolve(__dirname, '../renderer/src');
const view = readFileSync(resolve(SRC, 'components/DuplicatesGroupedView.tsx'), 'utf8');

describe('B107 duplicates group alignment', () => {
  it('every row renders the same-width slot; the badge lives inside it', () => {
    const m = /<span className="inline-block w-14 shrink-0">\s*\{isRep && \([\s\S]*?repBadge[\s\S]*?<\/span>\s*\)\}\s*<\/span>/.exec(view);
    expect(m).not.toBeNull();
    expect(view).not.toMatch(/\{isRep && \(\s*<span className="shrink-0/);
  });

  it('the badge is short in Russian and has a translated full-word tooltip', () => {
    for (const lang of ['en', 'ru']) {
      const d = JSON.parse(readFileSync(resolve(SRC, `i18n/locales/${lang}.json`), 'utf8')).duplicates;
      expect(d.repBadgeTitle, lang).toBeTruthy();
      expect(d.repBadge.length, lang).toBeLessThanOrEqual(7);
    }
  });
});
