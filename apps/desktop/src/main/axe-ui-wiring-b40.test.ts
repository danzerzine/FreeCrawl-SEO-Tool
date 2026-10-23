import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// The renderer project is not compiled by this test project: wiring is checked on the source text.
const src = (rel: string): string => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('B40 UI and IPC wiring', () => {
  it('axeQuery is an IPC channel, a preload method, a main handler reading through the reader worker', () => {
    expect(src('../../../../packages/shared-types/src/ipc.ts')).toMatch(/axeQuery: 'axe:query'/);
    expect(src('../preload/index.ts')).toMatch(/axeQuery: \(input: AxeQueryInput\)/);
    const main = src('./index.ts');
    expect(main).toMatch(/registerHandle\(\s*IPC\.axeQuery/);
    expect(main).toMatch(/'queryAxe'/);
  });

  it('the detail panel has the axe sub-tab (single URL only) and the two detail rows', () => {
    const panel = src('../renderer/src/components/BottomDetailPanel.tsx');
    expect(panel).toMatch(/key: 'axe', label: 'Accessibility \(axe\)'/);
    expect(panel).toMatch(/SINGLE_URL_ONLY_TABS[\s\S]*?'axe'/);
    expect(panel).toMatch(/<AxeView pageUrl=/);
    expect(panel).toContain("'Axe violations'");
    expect(panel).toContain("'Axe critical/serious'");
  });

  it('the axe view links the rule to its help URL, opens samples, and says "not audited" apart from "no violations"', () => {
    const view = src('../renderer/src/components/AxeView.tsx');
    expect(view).toMatch(/href=\{r\.helpUrl/);
    expect(view).toMatch(/detail\.axe\.notAudited/);
    expect(view).toMatch(/detail\.axe\.empty/);
    expect(view).toMatch(/axeQuery\(/);
  });

  it('the settings dialog has the axe checkbox next to the a11y one, saved to jsRender.axeAudit', () => {
    const dlg = src('../renderer/src/components/SettingsDialog.tsx');
    expect(dlg).toMatch(/settingsPanels\.rendering\.axeAudit/);
    expect(dlg).toMatch(/checked=\{form\.jsAxeAudit\}/);
    expect(dlg).toMatch(/axeAudit: form\.jsAxeAudit/);
  });
});
