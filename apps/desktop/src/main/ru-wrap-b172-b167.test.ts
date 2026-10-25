import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// B172 / B167: long Russian labels stay on one line instead of wrapping under their neighbours.
const SRC = resolve(__dirname, '../renderer/src');
const read = (p: string): string => readFileSync(resolve(SRC, p), 'utf8');

describe('Russian labels do not wrap', () => {
  it('B172: the axe impact cell and the Lighthouse savings headers are nowrap', () => {
    expect(read('components/AxeView.tsx')).toContain('<td className="whitespace-nowrap px-3 py-1">');
    expect(read('components/LighthouseView.tsx').match(/whitespace-nowrap px-2 py-1 text-right/g)).toHaveLength(2);
  });
  it('B167: analytics card titles stay on one line and carry the full text as a tooltip', () => {
    const panel = read('components/BottomDetailPanel.tsx');
    const card = /function AnalyticsCard[\s\S]*?\n}\n/.exec(panel)![0];
    expect(card).toContain('truncate whitespace-nowrap');
    expect(card).toContain('title={title}');
  });
});
