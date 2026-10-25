import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// B174: the axe and Lighthouse sub-tabs load and fail through the same code.
const comp = (f: string): string => readFileSync(resolve(__dirname, `../renderer/src/components/${f}`), 'utf8');

describe('axe and Lighthouse views share their loading', () => {
  it.each(['AxeView.tsx', 'LighthouseView.tsx'])('%s uses the shared hook and error message', (file) => {
    const src = comp(file);
    expect(src).toContain("from './StoredRows.js'");
    expect(src).toContain('useStoredRows<');
    expect(src).toContain('<LoadFailed error={loadError} />');
    expect(src).not.toContain('setLoadError');
    expect(src).not.toContain("t('common.loadFailedTitle'");
  });
  it('the hook reloads on a page or data change and clears the open row', () => {
    const src = comp('StoredRows.tsx');
    expect(src).toContain('[pageUrl, dataVersion]');
    expect(src).toContain('setOpen(null)');
  });
});
