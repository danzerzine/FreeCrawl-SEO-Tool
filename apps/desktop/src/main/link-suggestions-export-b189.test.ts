import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// The renderer project is not compiled by this test project: wiring is checked on the source text.
const src = (rel: string): string => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('B189 link-suggestions tab export', () => {
  it('the handler takes thresholds, runs the worker report and streams through exportTabular', () => {
    const main = src('./index.ts');
    const at = main.indexOf('IPC.reportsLinkSuggestionsExport,');
    expect(at).toBeGreaterThan(0);
    const handler = main.slice(at, at + 1600);
    expect(handler).toMatch(/input: LinkSuggestionInput/);
    expect(handler).not.toMatch(/rows: LinkSuggestionRow\[\]/);
    expect(handler).toMatch(/computeLinkSuggestions\(/);
    expect(handler).toMatch(/exportTabular\(/);
    expect(handler).not.toMatch(/buildCsvTable|datasetRows/);
  });

  it('the panel sends the thresholds of the shown result, not its rows', () => {
    const panel = src('../renderer/src/components/LinkSuggestionsPanel.tsx');
    expect(panel).toMatch(/reportsLinkSuggestionsExport\(shown\.current\)/);
    expect(panel).not.toMatch(/reportsLinkSuggestionsExport\(result\.rows\)/);
  });
});
