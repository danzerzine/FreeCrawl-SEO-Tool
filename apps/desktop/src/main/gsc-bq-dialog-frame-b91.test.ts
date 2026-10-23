import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const comp = (f: string): string =>
  fs.readFileSync(path.resolve(__dirname, '../renderer/src/components', f), 'utf8');

/**
 * The over-cap / changed-settings plan is taller than the Search Console pane, so the action
 * buttons must sit in a footer outside the scrolling part (PC pass shot bq-plan-overcap).
 */
describe('B91 plan dialog frame keeps Cancel and Pull visible', () => {
  const frame = comp('GscBqDialogFrame.tsx');
  const dialog = comp('GscBqPullDialog.tsx');

  it('the dialog box is a capped column and does not scroll itself', () => {
    const box = /role="dialog"[\s\S]*?className="([^"]*)"/.exec(frame)?.[1] ?? '';
    expect(box).toContain('flex-col');
    expect(box).toContain('max-h-[80%]');
    expect(box).not.toContain('overflow-y-auto');
  });

  it('the body scrolls and closes before the footer slot', () => {
    const bodyAt = frame.indexOf('overflow-y-auto');
    expect(bodyAt).toBeGreaterThan(-1);
    const footerAt = frame.indexOf('{footer}');
    expect(footerAt).toBeGreaterThan(bodyAt);
    const between = frame.slice(frame.lastIndexOf('<div', bodyAt), footerAt);
    const opens = (between.match(/<div\b/g) ?? []).length;
    const closes = (between.match(/<\/div>/g) ?? []).length;
    // The scroll div (and the footer's own wrapper) are opened; the scroll one is closed first.
    expect(opens - closes).toBe(1);
  });

  it('the pull dialog hands Cancel/Close, Rebuild and Pull to the footer, not to the body', () => {
    expect(dialog).toContain('<GscBqDialogFrame');
    const from = dialog.indexOf('const footer');
    const footer = dialog.slice(from, dialog.indexOf('return (', from));
    for (const k of ["'common.cancel'", "'gscBq.pull'", "'gscBq.rebuild'"]) expect(footer).toContain(k);
    const body = dialog.slice(dialog.indexOf('<GscBqDialogFrame'));
    expect(body).not.toContain("'gscBq.pull'");
  });
});
