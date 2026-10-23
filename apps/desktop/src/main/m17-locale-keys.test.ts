import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.resolve(__dirname, '../renderer/src/i18n/locales');
const load = (l: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), 'utf8'));
const get = (o: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o);

// Strings of the B41 Lighthouse view and the PageSpeed tab. The Russian UI must not fall back to English.
const KEYS = [
  'pagespeedTab.colOpportunities',
  'pagespeedTab.colTopSaving',
  'pagespeedTab.savingsOverlap',
  'pagespeedTab.rerunHint',
  'detail.lighthouse.tab',
  'detail.lighthouse.empty',
  'detail.lighthouse.colSavings',
  'detail.lighthouse.colSavingsMs',
  'detail.lighthouse.colSavingsKb',
  'detail.lighthouse.colAudit',
  'detail.lighthouse.colValue',
  'detail.lighthouse.kindOpportunity',
  'detail.lighthouse.kindInsight',
  'detail.lighthouse.kindDiagnostic',
  'detail.lighthouse.noResources',
  'detail.lighthouse.truncated',
  'detail.lighthouse.version',
  'detail.lighthouse.loading',
];
// Same word in both languages.
const SAME_IN_RU = new Set(['detail.lighthouse.tab']);

describe('B41 locale keys', () => {
  it('en has every key as a string', () => {
    const en = load('en');
    expect(KEYS.filter((k) => typeof get(en, k) !== 'string')).toEqual([]);
  });

  it('ru has every key as a string that is not the English text', () => {
    const en = load('en');
    const ru = load('ru');
    expect(KEYS.filter((k) => typeof get(ru, k) !== 'string')).toEqual([]);
    expect(KEYS.filter((k) => !SAME_IN_RU.has(k) && get(ru, k) === get(en, k))).toEqual([]);
  });

  it('the texts of the spec are the ones in en.json', () => {
    const en = load('en');
    expect(get(en, 'pagespeedTab.colOpportunities')).toBe('Opportunities');
    expect(get(en, 'pagespeedTab.colTopSaving')).toBe('Top saving (ms)');
    expect(get(en, 'pagespeedTab.savingsOverlap')).toBe('Savings overlap; do not add them up.');
    expect(get(en, 'detail.lighthouse.empty')).toBe('No Lighthouse data for this page. Run PageSpeed from the PageSpeed tab.');
    expect(get(en, 'pagespeedTab.rerunHint')).toBe('Re-run to see opportunities for pages tested before.');
  });

  it('interpolation placeholders match between en and ru', () => {
    const en = load('en');
    const ru = load('ru');
    const ph = (s: unknown) => (String(s).match(/\{\{\w+\}\}/g) ?? []).sort();
    for (const k of KEYS) expect(ph(get(ru, k))).toEqual(ph(get(en, k)));
  });

  it('the label maps carry the sub-tab and the export entry (translateLabel keys)', () => {
    // The map is a plain TS file of the renderer project, which this project does not compile: read the text.
    const ru = fs.readFileSync(path.join(dir, '../labels/ru.ts'), 'utf8');
    expect(ru).toMatch(/^\s*(?:'Lighthouse'|Lighthouse): '[^']+',$/m);
    expect(ru).toMatch(/^\s*'Lighthouse audits': '(?!Lighthouse audits')[^']+',$/m);
  });
});

// B40: strings of the axe-core view, the detail rows and the setting.
const AXE_KEYS = [
  'settingsPanels.rendering.axeAudit',
  'detail.axe.tab',
  'detail.axe.empty',
  'detail.axe.notAudited',
  'detail.axe.loading',
  'detail.axe.colRule',
  'detail.axe.colImpact',
  'detail.axe.colElements',
  'detail.axe.kindViolation',
  'detail.axe.kindNeedsReview',
  'detail.axe.impactCritical',
  'detail.axe.impactSerious',
  'detail.axe.impactModerate',
  'detail.axe.impactMinor',
  'detail.axe.impactNone',
  'detail.axe.version',
  'detail.axe.samples',
  'detail.axe.noSamples',
  'detail.axe.truncated',
];

describe('B40 locale keys', () => {
  it('en and ru carry every key as a string, ru not equal to en', () => {
    const en = load('en');
    const ru = load('ru');
    expect(AXE_KEYS.filter((k) => typeof get(en, k) !== 'string')).toEqual([]);
    expect(AXE_KEYS.filter((k) => typeof get(ru, k) !== 'string')).toEqual([]);
    expect(AXE_KEYS.filter((k) => get(ru, k) === get(en, k))).toEqual([]);
  });

  it('interpolation placeholders match between en and ru', () => {
    const en = load('en');
    const ru = load('ru');
    const ph = (s: unknown) => (String(s).match(/\{\{\w+\}\}/g) ?? []).sort();
    for (const k of AXE_KEYS) expect(ph(get(ru, k))).toEqual(ph(get(en, k)));
  });

  it('the label map has the sub-tab, the two detail rows and the three issue labels in Russian', () => {
    const ru = fs.readFileSync(path.join(dir, '../labels/ru.ts'), 'utf8');
    for (const label of [
      'Accessibility (axe)',
      'Axe violations',
      'Axe critical/serious',
      'Axe: Critical / Serious Violations',
      'Axe: Moderate / Minor Violations',
      'Axe: Needs Review',
    ]) {
      const esc = label.replace(/[/()]/g, '\\$&');
      expect(ru, label).toMatch(new RegExp(`^\\s*'${esc}': '(?!${esc}')[^']+',$`, 'm'));
    }
  });
});
