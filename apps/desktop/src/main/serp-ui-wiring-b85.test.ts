import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// The renderer project is not compiled by this test project: wiring is checked on the source text.
const src = (rel: string): string => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
const locale = (name: string): Record<string, unknown> =>
  JSON.parse(src(`../renderer/src/i18n/locales/${name}.json`)) as Record<string, unknown>;
const at = (obj: Record<string, unknown>, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);

const KEYS = [
  'reports.report.serpCheck',
  'reports.serp.paste',
  'reports.serp.openFile',
  'reports.serp.statusOk',
  'reports.serp.statusMissing',
  'reports.serp.statusTooShort',
  'reports.serp.statusTooLong',
  'reports.serp.statusTooWide',
  'reports.serp.statusTooNarrow',
  'reports.serp.duplicate',
  'reports.serp.summary',
  'reports.serp.limitsFrom',
  'reports.serp.tooMany',
];

describe('B85 SERP check: IPC and dialog wiring', () => {
  it('reports:serp-check is a channel, a preload method and a main handler on checkSerpInput', () => {
    expect(src('../../../../packages/shared-types/src/ipc.ts')).toMatch(
      /reportsSerpCheck: 'reports:serp-check'/,
    );
    expect(src('../preload/index.ts')).toMatch(/reportsSerpCheck: \(input: SerpCheckInput\)/);
    const main = src('./index.ts');
    expect(main).toMatch(/registerHandle\(\s*IPC\.reportsSerpCheck/);
    expect(main).toMatch(/checkSerpInput\(/);
  });

  it('the Reports dialog lists the SERP check and renders its panel instead of the bar table', () => {
    const dlg = src('../renderer/src/components/ReportsDialog.tsx');
    expect(dlg).toMatch(/'serp-check'/);
    expect(dlg).toMatch(/<SerpCheckPanel/);
    const panel = src('../renderer/src/components/SerpCheckPanel.tsx');
    expect(panel).toMatch(/<textarea/);
    expect(panel).toMatch(/type="file"/);
    expect(panel).toMatch(/reportsSerpCheck\(/);
    expect(panel).toMatch(/overview\?\.thresholds/);
    // The title preview is clipped at the pixel limit, in blue, description under it.
    expect(panel).toMatch(/titleTruncated/);
  });

  it('en and ru both carry every SERP string, and ru is translated', () => {
    const en = locale('en');
    const ru = locale('ru');
    for (const k of KEYS) {
      expect(typeof at(en, k), `en ${k}`).toBe('string');
      expect(typeof at(ru, k), `ru ${k}`).toBe('string');
      expect(at(ru, k), `ru ${k} differs`).not.toBe(at(en, k));
    }
  });
});
