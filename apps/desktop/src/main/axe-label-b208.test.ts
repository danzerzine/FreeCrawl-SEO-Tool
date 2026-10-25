import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const locale = (l: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../renderer/src/i18n/locales/${l}.json`, import.meta.url),
      'utf8',
    ),
  );

describe('axe "not audited" hint names the Rendering panel (B208)', () => {
  it('en', () => {
    const s: string = locale('en').detail.axe.notAudited;
    expect(s).toContain('Settings → Rendering');
    expect(s).not.toContain('JavaScript rendering');
  });
  it('ru', () => {
    const s: string = locale('ru').detail.axe.notAudited;
    expect(s).toContain('Настройки → Рендеринг');
  });
});
