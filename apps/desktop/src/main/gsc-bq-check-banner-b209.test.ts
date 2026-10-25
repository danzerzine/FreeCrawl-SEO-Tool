import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// B209: a failed BigQuery connection check is a banner over the stored data, not a replacement screen.
const tab = readFileSync(resolve(__dirname, '../renderer/src/tabs/SearchConsoleTab.tsx'), 'utf8');

describe('B209 Search Console BigQuery check', () => {
  it('a failed check keeps the data view and shows the error as the banner', () => {
    const m = /const check = await window\.freecrawl\.gscBqCheck\(\);[\s\S]*?\n {8}\} else if/.exec(tab);
    expect(m).not.toBeNull();
    const block = m![0];
    expect(block).toContain('setStage(\'ready\')');
    expect(block).not.toContain('setStage(\'error\')');
    expect(block).toContain('setError(check.error)');
  });
});
