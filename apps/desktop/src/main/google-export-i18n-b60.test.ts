import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const renderer = join(dirname(fileURLToPath(import.meta.url)), '../renderer/src');
const localesDir = join(renderer, 'i18n/locales');
const locales = readdirSync(localesDir).filter((f) => f.endsWith('.json'));

type Block = Record<string, string | Record<string, string>>;
const block = (file: string): Block =>
  (JSON.parse(readFileSync(join(localesDir, file), 'utf8')) as { googleExport?: Block }).googleExport ?? {};
const flat = (b: Block): Record<string, string> =>
  Object.fromEntries(
    Object.entries(b).flatMap(([k, v]) =>
      typeof v === 'string' ? [[k, v]] : Object.entries(v).map(([k2, v2]) => [`${k}.${k2}`, v2]),
    ),
  );

describe('Google export dialog labels (B60)', () => {
  const en = flat(block('en.json'));
  it('English holds the keys the dialog and the result messages use', () => {
    expect(Object.keys(en).sort()).toEqual(
      [
        'titleSheets', 'titleBigquery', 'tableLabel', 'truncated', 'rejected',
        'dataset.urls', 'dataset.issues-long', 'dataset.broken-links', 'dataset.images',
        'dataset.sitemap-urls', 'dataset.response-headers', 'dataset.crawl-queue',
      ].sort(),
    );
  });
  it.each(locales.filter((f) => f !== 'en.json'))('%s has every key, translated, with the same placeholders', (file) => {
    const loc = flat(block(file));
    expect(Object.keys(loc).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(loc)) {
      expect(v.trim(), k).not.toBe('');
      expect(v.match(/{{\w+}}/g)?.sort(), k).toEqual(en[k]!.match(/{{\w+}}/g)?.sort());
    }
    expect(loc['tableLabel']).not.toBe(en['tableLabel']);
  });
});
