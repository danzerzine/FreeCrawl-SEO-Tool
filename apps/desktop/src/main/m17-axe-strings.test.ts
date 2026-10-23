import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const i18n = path.resolve(__dirname, '../renderer/src/i18n');
const load = (l: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(i18n, 'locales', `${l}.json`), 'utf8'));
const get = (o: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o);

describe('M17 review fixes: axe setting strings and Russian wording', () => {
  it('the axe setting has a label with the WCAG level and a help text with the growth note, en and ru', () => {
    const en = load('en');
    const ru = load('ru');
    expect(get(en, 'settingsPanels.rendering.axeAudit')).toMatch(/\(WCAG 2\.2 A\/AA\)/);
    expect(get(ru, 'settingsPanels.rendering.axeAudit')).toMatch(/\(WCAG 2\.2 A\/AA\)/);
    expect(get(en, 'settingsPanels.rendering.axeAuditHelp')).toMatch(/several KB per page/);
    expect(get(ru, 'settingsPanels.rendering.axeAuditHelp')).toMatch(/несколько КБ на страницу/);
  });

  it('SettingsDialog reads the help through the locale key, not a hard-coded English string', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../renderer/src/components/SettingsDialog.tsx'), 'utf8');
    expect(src).toMatch(/info=\{t\('settingsPanels\.rendering\.axeAuditHelp'/);
    expect(src).not.toMatch(/info="Runs the axe-core/);
  });

  it('ru issue labels say критичные / мелкие, as the spec does', () => {
    const src = fs.readFileSync(path.join(i18n, 'labels/ru.ts'), 'utf8');
    expect(src).toContain("'Axe: Critical / Serious Violations': 'Axe: критичные и серьёзные нарушения'");
    expect(src).toContain("'Axe: Moderate / Minor Violations': 'Axe: умеренные и мелкие нарушения'");
    expect(src).not.toMatch(/критические|незначительные/);
  });

  it('"Audit" has one Russian word in the Lighthouse view', () => {
    const ru = load('ru');
    const src = fs.readFileSync(path.join(i18n, 'labels/ru.ts'), 'utf8');
    expect(get(ru, 'detail.lighthouse.colAudit')).toBe('Аудит');
    expect(src).toContain("'Lighthouse audits': 'Аудиты Lighthouse'");
  });
});
