import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const renderer = join(dirname(fileURLToPath(import.meta.url)), '../renderer/src');
const panel = readFileSync(join(renderer, 'components/AlertsSettingsSection.tsx'), 'utf8');
const localesDir = join(renderer, 'i18n/locales');
const locales = readdirSync(localesDir).filter((f) => f.endsWith('.json'));

/** Every leaf key under an object, dotted. */
function leaves(o: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' ? leaves(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

function alertsOf(file: string): Record<string, unknown> {
  const j = JSON.parse(readFileSync(join(localesDir, file), 'utf8')) as {
    settingsPanels?: { alerts?: Record<string, unknown> };
  };
  return j.settingsPanels?.alerts ?? {};
}

describe('Settings → Alerts labels (B88d)', () => {
  const used = new Set(
    [...panel.matchAll(/settingsPanels\.alerts\.([a-zA-Z.]+[a-zA-Z])/g)].map((m) => m[1]!),
  );
  const fixed = /const FIXED_METRIC_KEYS[^{]*\{([^}]*)\}/.exec(panel)![1]!;
  for (const m of fixed.matchAll(/: '([a-zA-Z0-9]+)',/g)) used.add(`metric.${m[1]}`);
  const en = leaves(alertsOf('en.json')).sort();

  it('every key the panel uses is in English', () => {
    expect(locales).toHaveLength(11);
    for (const k of used) if (k !== 'metric') expect(en, k).toContain(k);
  });

  it.each(locales)('%s has exactly the English keys, with the same placeholders', (file) => {
    const a = alertsOf(file);
    expect(leaves(a).sort()).toEqual(en);
    const enA = alertsOf('en.json');
    const get = (o: Record<string, unknown>, k: string) =>
      k.split('.').reduce<unknown>((x, p) => (x as Record<string, unknown>)[p], o) as string;
    for (const k of en) {
      const ph = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
      expect(ph(get(a, k)), `${file} ${k}`).toEqual(ph(get(enA, k)));
      if (file !== 'en.json') expect(get(a, k).trim().length, `${file} ${k}`).toBeGreaterThan(0);
    }
  });

  it.each(readdirSync(join(renderer, 'i18n/labels')))('%s translates the sidebar labels', (file) => {
    const src = readFileSync(join(renderer, 'i18n/labels', file), 'utf8');
    for (const label of ['Alerts', 'Notifications', 'Email']) {
      expect(src, `${file} ${label}`).toMatch(new RegExp(`^  '?${label}'?: '`, 'm'));
    }
  });
});
