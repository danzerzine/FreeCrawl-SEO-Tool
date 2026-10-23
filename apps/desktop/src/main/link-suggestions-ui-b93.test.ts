import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// The renderer project is not compiled by this test project: wiring is checked on the source text.
const src = (rel: string): string => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
const LOCALES = ['az', 'en', 'es', 'fr', 'hi', 'it', 'ko', 'pt-BR', 'ru', 'tr', 'zh-CN'];
const locale = (name: string): Record<string, unknown> =>
  JSON.parse(src(`../renderer/src/i18n/locales/${name}.json`)) as Record<string, unknown>;
const at = (obj: Record<string, unknown>, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();

/** Every key the panel asks for with t('reports.linkSuggestions.*') plus the report label. */
function usedKeys(): string[] {
  const files = ['LinkSuggestionsPanel.tsx', 'ReportsDialog.tsx'].map((f) =>
    src(`../renderer/src/components/${f}`),
  );
  const keys = new Set<string>();
  for (const s of files)
    for (const m of s.matchAll(
      /t\(\s*'(reports\.linkSuggestions\.\w+|reports\.report\.linkSuggestions)'/g,
    ))
      keys.add(m[1]!);
  return [...keys];
}

describe('B93 link suggestions: IPC, bridge and worker wiring', () => {
  it('reports:link-suggestions is a channel, a preload method and a main handler', () => {
    expect(src('../../../../packages/shared-types/src/ipc.ts')).toMatch(
      /reportsLinkSuggestions: 'reports:link-suggestions'/,
    );
    expect(src('../preload/index.ts')).toMatch(/reportsLinkSuggestions: \(input: LinkSuggestionInput\)/);
    expect(src('./index.ts')).toMatch(/registerHandle\(\s*IPC\.reportsLinkSuggestions/);
  });

  it('the bridge action and the IPC handler share one function that uses the worker on a disk project', () => {
    const main = src('./index.ts');
    expect(main).toMatch(/'report-link-suggestions': async/);
    expect(main).toMatch(/computeLinkSuggestions\(/);
    expect(main).toMatch(/runLinkSuggestionsInWorker\(/);
    expect(main).toMatch(/link-suggestions-worker\.js/);
    expect(main).toMatch(/storageModeActive === 'disk'/);
  });

  it('the worker entry is bundled next to the main bundle', () => {
    expect(src('../../electron.vite.config.ts')).toMatch(
      /'link-suggestions-worker': resolve\(__dirname, 'src\/main\/link-suggestions-worker\.ts'\)/,
    );
    expect(src('./link-suggestions-worker.ts')).toMatch(
      /import '@freecrawl\/core\/link-suggestions-worker'/,
    );
  });

  it('the Reports dialog lists the tab and renders the panel', () => {
    const dlg = src('../renderer/src/components/ReportsDialog.tsx');
    expect(dlg).toMatch(/'link-suggestions'/);
    expect(dlg).toMatch(/<LinkSuggestionsPanel/);
    const panel = src('../renderer/src/components/LinkSuggestionsPanel.tsx');
    expect(panel).toMatch(/reportsLinkSuggestions\(/);
    expect(panel).toMatch(/reportsLinkSuggestionsExport\(/);
    expect(panel).toMatch(/<InfoTip/);
    // the four thresholds are editable fields
    for (const f of ['maxInlinks', 'perTarget', 'perSource', 'minCloseness'])
      expect(panel, f).toContain(f);
  });
});

describe('B93 link suggestions: strings in all 11 locales', () => {
  const keys = usedKeys();
  it('finds the keys the UI uses', () => {
    expect(keys.length).toBeGreaterThan(15);
  });
  for (const l of LOCALES) {
    it(`${l} has every key with the same placeholders as en`, () => {
      const en = locale('en');
      const d = locale(l);
      for (const k of keys) {
        const v = at(d, k);
        expect(typeof v, `${l}:${k}`).toBe('string');
        expect(placeholders(v as string), `${l}:${k}`).toEqual(placeholders(at(en, k) as string));
      }
    });
  }
  it('ru is translated, not a copy of en', () => {
    const en = locale('en');
    const ru = locale('ru');
    for (const k of keys) expect(at(ru, k), `ru ${k}`).not.toBe(at(en, k));
  });
});

describe('B93 info tip', () => {
  it('the panel tip has an entry in every info-tip table', () => {
    const panel = src('../renderer/src/components/LinkSuggestionsPanel.tsx');
    const tip = /const INFO_TIP =\s*'((?:[^'\\]|\\.)*)'/.exec(panel)?.[1];
    expect(tip, 'INFO_TIP literal').toBeTruthy();
    for (const l of LOCALES.filter((x) => x !== 'en')) {
      expect(src(`../renderer/src/i18n/info-tips/${l}.ts`), l).toContain(tip!);
    }
  });
});
